// 网络层：优先走油猴 GM 跨域桥，其次直连 fetch，最后可选 CORS 代理模板
import { log } from "./util.js";

export class NetError extends Error {
  constructor(msg, { status = 0, retryable = false, url = "" } = {}) {
    super(msg);
    this.name = "NetError";
    this.status = status;
    this.retryable = retryable;
    this.url = url;
  }
}

// 油猴脚本在主页注入的桥对象
export function bridge() {
  const b = window.__WD_BRIDGE;
  return b && typeof b.request === "function" ? b : null;
}

export function hasBridge() {
  return !!bridge();
}

export function bridgeInfo() {
  const b = bridge();
  if (!b) return { gm: false, download: false };
  return { gm: true, download: typeof b.download === "function", version: b.version || "?" };
}

function proxyUrl(template, url) {
  if (!template) return null;
  if (template.includes("{url}")) return template.replace("{url}", encodeURIComponent(url));
  return template + url;
}

// 桥方法以回调形式返回，避免跨沙箱 Promise 不可 await 的问题；同时兼容返回 Promise 的实现
function callBridge(fn, ...args) {
  return new Promise((resolve, reject) => {
    let done = false;
    const cb = (res) => { if (!done) { done = true; res && res.error ? reject(new Error(res.error)) : resolve(res); } };
    let ret;
    try {
      ret = fn(...args, cb);
    } catch (e) { reject(e); return; }
    if (ret && typeof ret.then === "function") {
      ret.then((res) => { if (!done) { done = true; resolve(res); } }, (e) => { if (!done) { done = true; reject(e); } });
    }
  });
}

// 单次请求，返回 { status, headers, body: ArrayBuffer|Blob|string }
async function requestOnce(url, { method = "GET", headers, range, expect = "arraybuffer", proxy, signal, timeout = 60000 } = {}) {
  const b = bridge();
  if (b) {
    const reqId = Math.random().toString(36).slice(2);
    let onAbort;
    try {
      if (signal) {
        onAbort = () => { try { b.abort && b.abort(reqId); } catch { /* 忽略 */ } };
        signal.addEventListener("abort", onAbort, { once: true });
      }
      const r = await callBridge(b.request, { url, method, headers, range, timeout, id: reqId });
      if (r.aborted) throw new NetError("请求已取消", { retryable: false });
      const blob = await loadObjectUrl(r.objectUrl);
      if (r.status === 404 || (r.status >= 400 && r.status !== 416 && r.status !== 206)) {
        throw new NetError(`HTTP ${r.status}`, { status: r.status, retryable: r.status >= 500 || r.status === 429, url });
      }
      if (expect === "text") return { status: r.status, headers: r.headers || {}, body: await blob.text() };
      if (expect === "blob") return { status: r.status, headers: r.headers || {}, body: blob };
      return { status: r.status, headers: r.headers || {}, body: await blob.arrayBuffer() };
    } catch (e) {
      if (e instanceof NetError) throw e;
      log("GM 桥请求失败，尝试直连:", url, e.message);
    } finally {
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  // 直连 / 代理
  const finalUrl = (!b && proxy) ? (proxyUrl(proxy, url) || url) : url;
  const h = { ...(headers || {}) };
  if (range) h.Range = `bytes=${range[0]}-${range[1]}`;
  let resp;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    if (signal) signal.addEventListener("abort", () => ctrl.abort(), { once: true });
    resp = await fetch(finalUrl, { method, headers: h, signal: ctrl.signal, credentials: "omit", referrerPolicy: "no-referrer" });
    clearTimeout(timer);
  } catch (e) {
    const aborted = signal && signal.aborted;
    throw new NetError(aborted ? "请求已取消" : (e.message || "网络错误"), { retryable: !aborted, url });
  }
  if (resp.status >= 400 && resp.status !== 416) {
    throw new NetError(`HTTP ${resp.status}`, { status: resp.status, retryable: resp.status >= 500 || resp.status === 429, url });
  }
  const headersOut = {};
  resp.headers.forEach((v, k) => { headersOut[k.toLowerCase()] = v; });
  if (expect === "text") return { status: resp.status, headers: headersOut, body: await resp.text() };
  if (expect === "blob") return { status: resp.status, headers: headersOut, body: await resp.blob() };
  return { status: resp.status, headers: headersOut, body: await resp.arrayBuffer() };
}

// 桥返回的是 blob: URL（跨沙箱传递二进制的安全方式），读完即释放
async function loadObjectUrl(objectUrl) {
  if (!objectUrl) throw new NetError("桥未返回数据");
  const resp = await fetch(objectUrl);
  if (!resp.ok) throw new NetError(`桥数据读取失败 ${resp.status}`, { retryable: true });
  const blob = await resp.blob();
  setTimeout(() => { try { URL.revokeObjectURL(objectUrl); } catch { /* 由脚本侧兜底释放 */ } }, 1000);
  return blob;
}

export function getText(url, opts = {}) {  return requestOnce(url, { ...opts, expect: "text" });
}

export function getBlob(url, opts = {}) {
  return requestOnce(url, { ...opts, expect: "blob" });
}

export function getArrayBuffer(url, opts = {}) {
  return requestOnce(url, { ...opts, expect: "arraybuffer" });
}

export function getRange(url, start, end, opts = {}) {
  return requestOnce(url, { ...opts, expect: "arraybuffer", method: "GET", range: [start, end] });
}

// 探测大小、类型、是否支持 Range
export async function probe(url, opts = {}) {
  let r;
  try {
    r = await requestOnce(url, { ...opts, method: "HEAD", expect: "arraybuffer", timeout: 20000 });
  } catch (e) {
    if (e.status === 405 || e.status === 501 || e.status === 0) {
      // HEAD 不被支持：用 GET 首字节代替
      r = await requestOnce(url, { ...opts, expect: "arraybuffer", range: [0, 1] });
      const cr = r.headers["content-range"];
      const total = cr ? parseInt(cr.split("/")[1], 10) : 0;
      return { size: total, mime: r.headers["content-type"] || "", acceptRanges: !!cr || r.status === 206, headers: r.headers };
    }
    throw e;
  }
  const cr = r.headers["content-range"];
  let size = parseInt(r.headers["content-length"] || "0", 10);
  if (cr) size = parseInt(cr.split("/")[1], 10) || size;
  return {
    size,
    mime: (r.headers["content-type"] || "").split(";")[0],
    acceptRanges: (r.headers["accept-ranges"] || "").includes("bytes") || r.status === 206,
    headers: r.headers,
  };
}

// 脚本侧 GM 存储（跨站点共享：嗅探列表、任务收件箱、设置）
export function bridgeKvGet(key, def) {
  const b = bridge();
  if (!b || !b.kvGet) return Promise.resolve(def);
  return Promise.race([
    callBridge(b.kvGet, key, def).then(r => (r && "v" in r ? r.v : (r === undefined ? def : r))),
    new Promise(res => setTimeout(() => res(def), 5000)),
  ]);
}

export function bridgeKvSet(key, val) {
  const b = bridge();
  if (!b || !b.kvSet) return Promise.resolve(false);
  return Promise.race([
    callBridge(b.kvSet, key, val).then(() => true, () => false),
    new Promise(res => setTimeout(() => res(false), 5000)),
  ]);
}
