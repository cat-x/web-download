// ==UserScript==
// @name         Web下载器【嗅探 + 统一主页】
// @name:zh-CN   Web下载器【嗅探 + 统一主页】
// @version      3.1.0
// @description  全站嗅探 m3u8 / 视频直链，悬浮球管理，任务确认后派发到统一主页下载器：多线程分片、分段直写本地文件、断点续传、转封装 MP4。确认框显示保存路径，主页地址可在设置中修改并检测可达性。
// @author       you
// @homepage     https://cat-x.github.io/web-download/
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM.openInTab
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @connect      *
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "3.1.0";
  const DEFAULT_HOME = "https://cat-x.github.io/web-download/";
  const MSG_SNIFF = "wd3:sniff";
  const isTop = window.top === window;

  function gmVal(key, def) {
    try { return GM_getValue(key, def); } catch { return def; }
  }

  // 主页地址每次实时读取：wd3:home 是脚本内手动设置的，优先级高于主页自动上报的 wd:settings.homeUrl
  function getHomeUrl() {
    const raw = gmVal("wd3:home", "") || (gmVal("wd:settings", {}) || {}).homeUrl || DEFAULT_HOME;
    try { return new URL(raw).href; } catch { return DEFAULT_HOME; }
  }

  const isHome = (() => {
    try {
      const h = new URL(getHomeUrl());
      return h.host === location.host && location.pathname.startsWith(h.pathname.replace(/\/[^/]*$/, "/"));
    } catch { return false; }
  })();

  const gm = {
    get(k, d) { try { return GM_getValue(k, d); } catch { return d; } },
    set(k, v) { try { GM_setValue(k, v); } catch { /* 忽略 */ } },
    async getAsync(k, d) {
      try { return await (typeof GM_getValue === "function" ? GM_getValue(k, d) : GM.getValue(k, d)); }
      catch { return d; }
    },
    async setAsync(k, v) {
      try { return await (typeof GM_setValue === "function" ? GM_setValue(k, v) : GM.setValue(k, v)); }
      catch { /* 忽略 */ }
    },
    openTab(url, background = false) {
      try {
        (typeof GM_openInTab === "function" ? GM_openInTab : GM.openInTab)(url, { active: !background, insert: true });
      } catch (e) { window.open(url, "_blank"); }
    },
    xhr(details) {
      return (typeof GM_xmlhttpRequest === "function" ? GM_xmlhttpRequest : GM.xmlHttpRequest)(details);
    },
  };

  // 主页可达性探测：地址失效/站点未发布时不要开一个 404 标签页
  let homeProbe = { url: "", ok: false, status: 0, ts: 0 };
  function checkHome(url, force) {
    if (!force && homeProbe.url === url && Date.now() - homeProbe.ts < 60000) return Promise.resolve(homeProbe);
    return new Promise((resolve) => {
      let finished = false;
      // 个别管理器不触发回调，兜底放行，避免派发被卡死
      const guard = setTimeout(() => settle(true, -1), 9000);
      const settle = (ok, status) => {
        if (finished) return;
        finished = true;
        clearTimeout(guard);
        homeProbe = { url, ok, status, ts: Date.now() };
        resolve(homeProbe);
      };
      try {
        gm.xhr({
          method: "HEAD", url, timeout: 8000,
          onerror: () => settle(false, 0),
          ontimeout: () => settle(false, 0),
          onload: (r) => settle((r.status >= 200 && r.status < 400) || r.status === 405 || r.status === 501, r.status),
        });
      } catch { settle(true, -1); } // 缺少权限等异常不阻塞派发
    });
  }

  // 空串代表恢复自动；缺协议头时补 https
  function normalizeHome(v) {
    const raw = String(v || "").trim();
    if (!raw) return "";
    try { return new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`).href; } catch { return null; }
  }

  // ============================================================
  // 1) GM 跨域桥：主页下载器通过它代发请求，绕开 CORS
  // ============================================================
  function injectBridge() {
    const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    if (W.__WD_BRIDGE) return;
    const inflight = new Map();
    const revokeLater = (u) => setTimeout(() => { try { W.URL.revokeObjectURL(u); } catch { /* 已被释放 */ } }, 60000);

    W.__WD_BRIDGE = {
      version: VERSION,

      // opts: { url, method, headers, range, timeout, id } → cb({ status, headers, objectUrl })
      request(opts, cb) {
        let settled = false;
        const done = (res) => { if (!settled) { settled = true; cb(res); } };
        const headers = { ...(opts.headers || {}) };
        if (opts.range) headers.Range = `bytes=${opts.range[0]}-${opts.range[1]}`;
        if (opts.referer && !headers.Referer) headers.Referer = opts.referer;
        const req = gm.xhr({
          method: opts.method || "GET",
          url: opts.url,
          headers,
          responseType: "arraybuffer",
          timeout: opts.timeout || 120000,
          anonymous: !opts.referer,
          onload(r) {
            let type = "";
            const raw = (r.responseHeaders || "").split("\n");
            const hdrs = {};
            for (const line of raw) {
              const m = line.match(/^\s*([\w-]+)\s*:\s*(.*)$/);
              if (m) { hdrs[m[1].toLowerCase()] = m[2]; if (m[1].toLowerCase() === "content-type") type = m[2]; }
            }
            let objectUrl = "";
            try {
              const blob = new W.Blob([r.response], { type: type || "application/octet-stream" });
              objectUrl = W.URL.createObjectURL(blob);
            } catch (e) { done({ error: "桥内构造数据失败: " + e.message }); return; }
            revokeLater(objectUrl);
            inflight.delete(opts.id);
            done({ status: r.status, headers: hdrs, objectUrl });
          },
          onerror() { inflight.delete(opts.id); done({ error: "网络错误" }); },
          ontimeout() { inflight.delete(opts.id); done({ error: "请求超时" }); },
          onabort() { inflight.delete(opts.id); done({ aborted: true }); },
        });
        if (opts.id) inflight.set(opts.id, req);
      },

      abort(id) {
        const r = inflight.get(id);
        if (r) { try { r.abort(); } catch { /* 忽略 */ } inflight.delete(id); }
      },

      kvGet(key, def, cb) {
        gm.getAsync(key, def).then(v => cb({ v }), e => cb({ error: String(e) }));
      },

      kvSet(key, val, cb) {
        gm.setAsync(key, val).then(() => cb({ ok: true }), e => cb({ error: String(e) }));
      },
    };
  }

  injectBridge();

  // ============================================================
  // 2) 资源嗅探
  // ============================================================
  let settingsCache = { threads: 4, remuxMp4: true, sanitizeName: true, popup: true, bubble: true, sniffEnabled: true };
  let sniffList = [];

  async function refreshSettings() {
    const s = await gm.getAsync("wd:settings", {});
    settingsCache = Object.assign(settingsCache, s || {});
    if (ui) ui.renderSettings();
  }

  // 保存路径来自主页下载器写入的 wd:settings（脚本侧只读展示）
  function savePathText() {
    const s = settingsCache;
    if (s.backend === "fs") return `本地文件夹：${s.dirName || "已授权文件夹"}（分段直写）`;
    if (s.dirName) return `本地文件夹：${s.dirName}`;
    if (s.backend === "idb") return "浏览器默认下载目录（先缓存，完成后另存）";
    return "沿用主页下载器「设置」中的路径";
  }

  function looksLikePlaylistText(text) {
    return typeof text === "string" && /^\s*#EXTM3U/m.test(text.slice(0, 256));
  }

  function isPlaylistUrl(u) {
    try { const p = new URL(u, location.href).pathname.toLowerCase(); return /\.(m3u8|m3u)$/.test(p); } catch { return false; }
  }

  function isMediaUrl(u) {
    try { const p = new URL(u, location.href).pathname.toLowerCase(); return /\.(mp4|m4v|webm|mkv|flv|mov|ts|mp3|m4a|aac|opus)$/.test(p); } catch { return false; }
  }

  function guessKind(u) { return isPlaylistUrl(u) ? "hls" : "file"; }

  const reported = new Set();

  // 记录并上报（iframe 内只向顶层投递，不建 UI）
  async function addFound(url, { title, duration, segCount, from } = {}) {
    let abs;
    try { abs = new URL(url, location.href).href; } catch { return; }
    if (!/^https?:/i.test(abs) || reported.has(abs)) return;
    reported.add(abs);
    const item = {
      url: abs,
      kind: guessKind(abs),
      title: title || document.title || abs.split("/").pop(),
      referer: location.href,
      host: location.host,
      duration: duration || 0,
      segCount: segCount || 0,
      from: from || "page",
      ts: Date.now(),
    };
    if (!isTop) {
      try { window.top.postMessage({ type: MSG_SNIFF, item }, "*"); } catch { /* 顶层不可达 */ }
      return;
    }
    if (sniffList.some(s => s.url === abs)) return;
    sniffList.unshift(item);
    if (sniffList.length > 300) sniffList.length = 300;
    const stored = await gm.getAsync("wd:sniff", []);
    const merged = [...sniffList, ...(Array.isArray(stored) ? stored : [])]
      .filter((s, i, arr) => s && s.url && arr.findIndex(x => x.url === s.url) === i)
      .slice(0, 300);
    sniffList = merged;
    await gm.setAsync("wd:sniff", merged);
    if (ui) {
      ui.add(item);
      if (settingsCache.popup) ui.toast(`嗅探到${item.kind === "hls" ? " m3u8" : "视频"}资源：${short(item.title)}`);
    }
  }

  function short(s) { return (s || "").length > 28 ? s.slice(0, 28) + "…" : s || ""; }

  // 2.1 fetch/XHR 响应体嗅探
  function patchNetwork() {
    const W = typeof unsafeWindow !== "undefined" ? unsafeWindow : window;
    try {
      const origText = W.Response.prototype.text;
      W.Response.prototype.text = function () {
        const self = this;
        return origText.call(this).then(t => {
          if (looksLikePlaylistText(t)) {
            const u = self.url || location.href;
            summarizePlaylist(t, u).then(info => addFound(u, { ...info, from: "fetch" }));
          }
          return t;
        });
      };
    } catch (e) { log("patch Response 失败", e); }

    try {
      const origOpen = W.XMLHttpRequest.prototype.open;
      W.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        this.addEventListener("load", () => {
          try {
            if (this.responseType === "" || this.responseType === "text") {
              const t = this.responseText;
              if (looksLikePlaylistText(t)) {
                summarizePlaylist(t, url).then(info => addFound(url, { ...info, from: "xhr" }));
              }
            }
          } catch { /* 跨域读取受限 */ }
        });
        return origOpen.call(this, method, url, ...rest);
      };
    } catch (e) { log("patch XHR 失败", e); }

    // 直接请求的 m3u8（performance entries 兜底）
    setInterval(() => {
      try {
        for (const e of performance.getEntriesByType("resource")) {
          if (isPlaylistUrl(e.name)) addFound(e.name, { from: "perf" });
        }
      } catch { /* 忽略 */ }
    }, 4000);
  }

  // 2.2 video / source / a 标签扫描
  function patchDom() {
    const scan = () => {
      for (const v of document.querySelectorAll("video")) {
        const src = v.currentSrc || v.src;
        if (src && /^https?:/i.test(src)) {
          addFound(src, { duration: v.duration && isFinite(v.duration) ? v.duration : 0, from: "video" });
        }
      }
      for (const s of document.querySelectorAll("source[src]")) {
        const src = s.getAttribute("src");
        if (src && (isPlaylistUrl(src) || isMediaUrl(src))) addFound(new URL(src, location.href).href, { from: "source" });
      }
      for (const a of document.querySelectorAll('a[href$=".m3u8"], a[href*=".m3u8?"]')) {
        addFound(a.href, { from: "link" });
      }
    };
    setInterval(scan, 1500);
    new MutationObserver(() => scan()).observe(document.documentElement, { childList: true, subtree: true, attributes: true });
    document.addEventListener("DOMContentLoaded", scan);
  }

  // 拉取播放列表摘要（时长/分片数），失败不影响展示
  function summarizePlaylist(text, url) {
    return new Promise(resolve => {
      const segs = (text.match(/^[^#\s][^\r\n]*$/gm) || []).length;
      const dur = (text.match(/#EXTINF:([\d.]+)/g) || []).reduce((a, s) => a + parseFloat(s.split(":")[1]), 0);
      if (/#EXT-X-STREAM-INF/i.test(text)) {
        // master：需要再取一次子列表才能知道分片数
        if (!isTop) return resolve({ segCount: 0, duration: 0 });
        const first = (text.split(/\r?\n/).find((l, i, arr) => arr[i - 1] && arr[i - 1].startsWith("#EXT-X-STREAM-INF") && l.trim() && !l.startsWith("#")) || "").trim();
        if (!first) return resolve({ segCount: 0, duration: 0 });
        let sub;
        try { sub = new URL(first, url).href; } catch { return resolve({ segCount: 0, duration: 0 }); }
        const timer = setTimeout(() => resolve({ segCount: 0, duration: 0 }), 6000);
        gm.xhr({
          method: "GET", url: sub, timeout: 6000,
          onload(r) {
            clearTimeout(timer);
            const info = summarizePlaylistSync(r.responseText || "");
            resolve({ ...info, duration: info.duration });
          },
          onerror() { clearTimeout(timer); resolve({ segCount: 0, duration: 0 }); },
          ontimeout() { clearTimeout(timer); resolve({ segCount: 0, duration: 0 }); },
        });
        return;
      }
      resolve(summarizePlaylistSync(text));
    });
  }

  function summarizePlaylistSync(text) {
    const segs = (text.match(/^[^#\s][^\r\n]*$/gm) || []).length;
    const dur = (text.match(/#EXTINF:([\d.]+)/g) || []).reduce((a, s) => a + (parseFloat(s.split(":")[1]) || 0), 0);
    return { segCount: segs, duration: dur };
  }

  // ============================================================
  // 3) 悬浮球 + 嗅探面板 + 任务确认（Shadow DOM，避免污染站点样式）
  // ============================================================
  let ui = null;

  const CSS = `
:host { all: initial; }
* { font-family: -apple-system, "PingFang SC", "Microsoft YaHei", Segoe UI, sans-serif; box-sizing: border-box; }
.wrap { position: fixed; z-index: 2147483647; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.bubble {
  width: 42px; height: 42px; border-radius: 50%;
  background: linear-gradient(145deg, #2f6bff, #35c3f0);
  color: #fff; font-size: 20px; cursor: grab; user-select: none;
  display: flex; align-items: center; justify-content: center;
  box-shadow: 0 4px 14px rgba(0,0,0,.4); position: relative;
}
.bubble .count {
  position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px;
  background: #16a34a; color: #fff; font-size: 11px; border-radius: 9px;
  display: none; align-items: center; justify-content: center; padding: 0 4px;
}
.bubble .count.on { display: flex; }
.panel {
  width: 380px; max-height: 60vh; overflow: auto; display: none;
  background: #10141d; color: #dfe6f5; border: 1px solid #262f45;
  border-radius: 10px; padding: 10px; font-size: 13px;
  box-shadow: 0 8px 30px rgba(0,0,0,.5);
}
.panel.on { display: block; }
.panel h4 { margin: 2px 0 8px; font-size: 13px; display: flex; align-items: center; gap: 6px; }
.panel h4 .x { margin-left: auto; cursor: pointer; color: #8b97b0; }
.item { padding: 8px; border-bottom: 1px solid #1e2536; }
.item:last-child { border-bottom: none; }
.item .t { display: flex; align-items: center; gap: 6px; }
.item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge { padding: 1px 6px; border-radius: 4px; font-size: 11px; background: #3a2f14; color: #f0b429; }
.badge.file { background: #14263a; color: #35c3f0; }
.item .url { color: #8b97b0; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin: 4px 0; }
.item .ops { display: flex; gap: 6px; }
.item .ops button, .foot button {
  padding: 3px 9px; border: 1px solid #2b3550; border-radius: 5px;
  background: #1b2233; color: #dfe6f5; font-size: 12px; cursor: pointer;
}
.item .ops button.go { background: #2f6bff; border-color: #2f6bff; color: #fff; }
.item .ops button:hover, .foot button:hover { filter: brightness(1.2); }
.foot { display: flex; gap: 8px; padding-top: 8px; }
.foot button { flex: 1; padding: 6px; }
.empty { color: #8b97b0; text-align: center; padding: 16px 0; }
.toast {
  background: #000; color: #fff; padding: 6px 12px; border-radius: 6px;
  font-size: 12px; box-shadow: 0 2px 8px rgba(0,0,0,.5); max-width: 320px;
}
.mask { position: fixed; inset: 0; background: rgba(6,9,15,.7); display: none; align-items: center; justify-content: center; z-index: 2147483647; }
.mask.on { display: flex; }
.dialog { width: 520px; max-width: 92vw; background: #141926; border: 1px solid #262f45; border-radius: 12px; padding: 20px; color: #dfe6f5; }
.dialog h3 { margin: 0 0 14px; font-size: 16px; }
.row { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; font-size: 13px; }
.row .k { width: 68px; color: #8b97b0; flex-shrink: 0; }
.row input[type=text] { flex: 1; padding: 7px 9px; background: #0d1017; color: #dfe6f5; border: 1px solid #2f6bff; border-radius: 6px; }
.row input[type=number] { width: 62px; padding: 6px; background: #0d1017; color: #dfe6f5; border: 1px solid #262f45; border-radius: 6px; }
.row label { display: inline-flex; align-items: center; gap: 5px; cursor: pointer; }
.row .sub { color: #8b97b0; font-size: 11px; }
.urltext { max-width: 380px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #35c3f0; font-size: 12px; }
.path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #dfe6f5; font-size: 12px; }
.tiny { padding: 4px 10px; border: 1px solid #2b3550; border-radius: 6px; background: #1b2233; color: #dfe6f5; font-size: 12px; cursor: pointer; }
.status { font-size: 12px; }
.status.ok { color: #16a34a; }
.status.err { color: #f0575b; }
.ops2 { display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px; }
.ops2 button { padding: 8px 18px; border-radius: 8px; border: 1px solid #262f45; background: #1b2233; color: #dfe6f5; cursor: pointer; }
.ops2 button.primary { background: #2f6bff; border-color: #2f6bff; color: #fff; }
`;

  function buildUI() {
    const host = document.createElement("div");
    host.id = "wd3-host";
    host.style.cssText = "all:initial;position:fixed;top:0;right:0;z-index:2147483647;";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);

    const wrap = document.createElement("div");
    wrap.className = "wrap";
    wrap.innerHTML = `
      <div class="bubble" title="Web下载器">⚡<span class="count">0</span></div>
      <div class="panel">
        <h4>📡 嗅探到资源 <span class="n">0</span><span class="x" title="收起">✕</span></h4>
        <div class="items"><div class="empty">暂未发现资源</div></div>
        <div class="foot">
          <button class="open">打开下载器主页</button>
          <button class="cfg">设置</button>
          <button class="clear">清空</button>
        </div>
      </div>`;
    shadow.appendChild(wrap);

    const mask = document.createElement("div");
    mask.className = "mask";
    shadow.appendChild(mask);

    const toasts = document.createElement("div");
    toasts.style.cssText = "position:fixed;right:16px;bottom:16px;display:flex;flex-direction:column;align-items:flex-end;gap:6px;";
    shadow.appendChild(toasts);

    (document.body || document.documentElement).appendChild(host);
    return { host, shadow, wrap, mask, toasts };
  }

  function initUI() {
    if (!isTop) return;
    const els = buildUI();
    const bubble = els.wrap.querySelector(".bubble");
    const panel = els.wrap.querySelector(".panel");
    const countEl = els.wrap.querySelector(".count");
    const nEl = els.wrap.querySelector(".n");
    const itemsEl = els.wrap.querySelector(".items");

    let pos = gm.get("wd3:pos", { x: 12, y: 90 });
    let shown = gm.get("wd3:shown", true);
    els.wrap.style.right = pos.x + "px";
    els.wrap.style.top = pos.y + "px";
    panel.classList.toggle("on", shown);

    bubble.addEventListener("click", () => {
      shown = !shown;
      gm.set("wd3:shown", shown);
      panel.classList.toggle("on", shown);
    });
    let drag = null;
    bubble.addEventListener("mousedown", (e) => {
      drag = { x: e.clientX, y: e.clientY, moved: false, ox: pos.x, oy: pos.y };
      const move = (ev) => {
        if (!drag) return;
        const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        if (drag.moved) {
          pos.x = Math.max(4, Math.min(innerWidth - 60, drag.ox - dx));
          pos.y = Math.max(4, Math.min(innerHeight - 60, drag.oy + dy));
          els.wrap.style.right = pos.x + "px";
          els.wrap.style.top = pos.y + "px";
        }
      };
      const up = () => {
        if (drag && drag.moved) gm.set("wd3:pos", pos);
        drag = null;
        removeEventListener("mousemove", move); removeEventListener("mouseup", up);
      };
      addEventListener("mousemove", move); addEventListener("mouseup", up);
    });
    els.wrap.querySelector(".x").onclick = (e) => {
      e.stopPropagation();
      shown = false; gm.set("wd3:shown", false); panel.classList.remove("on");
    };
    els.wrap.querySelector(".clear").onclick = async () => {
      sniffList = [];
      await gm.setAsync("wd:sniff", []);
      render();
    };
    els.wrap.querySelector(".open").onclick = () => gm.openTab(getHomeUrl(), false);
    els.wrap.querySelector(".cfg").onclick = () => settingsDialog();

    function render() {
      countEl.textContent = sniffList.length;
      countEl.classList.toggle("on", sniffList.length > 0);
      nEl.textContent = sniffList.length;
      itemsEl.innerHTML = "";
      if (!sniffList.length) { itemsEl.innerHTML = '<div class="empty">暂未发现资源</div>'; return; }
      for (const it of sniffList.slice(0, 30)) itemsEl.appendChild(row(it));
    }

    function row(it) {
      const d = document.createElement("div");
      d.className = "item";
      const dur = it.duration ? `${Math.round(it.duration / 60)} 分钟` : it.segCount ? `${it.segCount} 分片` : "";
      d.innerHTML = `
        <div class="t"><span class="badge ${it.kind === "file" ? "file" : ""}">${it.kind === "file" ? "文件" : "m3u8"}</span>
        <span class="name" title="${esc(it.title)}">${esc(it.title)}</span><span class="sub">${dur}</span></div>
        <div class="url" title="${esc(it.url)}">${esc(it.url)}</div>
        <div class="ops"><button class="go">下载</button><button class="cp">复制</button><button class="src">源页</button></div>`;
      d.querySelector(".go").onclick = () => confirmDialog(it);
      d.querySelector(".cp").onclick = () => { copyText(it.url); toast("已复制链接"); };
      d.querySelector(".src").onclick = () => it.referer && gm.openTab(it.referer, true);
      return d;
    }

    function confirmDialog(it) {
      els.mask.classList.add("on");
      els.mask.innerHTML = "";
      const dlg = document.createElement("div");
      dlg.className = "dialog";
      const defaultName = (document.title || it.title || "download").replace(/\.[a-z0-9]{1,5}$/i, "");
      dlg.innerHTML = `
        <h3>🔔 确认下载任务</h3>
        <div class="row"><span class="k">资源链接</span><span class="urltext" title="${esc(it.url)}">${esc(it.url)}</span></div>
        <div class="row"><span class="k">来源</span><span class="urltext">${esc(it.host || "")}</span></div>
        <div class="row"><span class="k">文件名</span><input type="text" class="name" value="${esc(defaultName)}"></div>
        <div class="row"><span class="k">线程数</span><input type="number" class="th" min="1" max="16" value="${settingsCache.threads || 4}">
          <label><input type="checkbox" class="start" checked> 立即开始</label></div>
        <div class="row"><span class="k"></span><label><input type="checkbox" class="remux" ${settingsCache.remuxMp4 ? "checked" : ""}> 完成后转 MP4</label>
          <span class="sub">无损重封装，首次使用需联网加载组件</span></div>
        <div class="row"><span class="k"></span><label><input type="checkbox" class="sani" ${settingsCache.sanitizeName !== false ? "checked" : ""}> 文件名跨平台自动修正</label></div>
        <div class="row"><span class="k">保存路径</span><span class="path" title="${esc(savePathText())}">${esc(savePathText())}</span></div>
        <div class="row"><span class="k"></span><span class="sub">任务将在统一主页下载器中执行，支持分段直写本地文件与断点续传。路径在主页「设置」中修改。</span></div>
        <div class="ops2"><button class="cancel">取消</button><button class="primary ok">开始下载</button></div>`;
      els.mask.appendChild(dlg);
      dlg.querySelector(".cancel").onclick = () => els.mask.classList.remove("on");
      els.mask.onclick = (e) => { if (e.target === els.mask) els.mask.classList.remove("on"); };
      dlg.querySelector(".ok").onclick = async () => {
        const payload = {
          url: it.url,
          kind: it.kind,
          title: defaultName || it.title,
          filename: dlg.querySelector(".name").value.trim() || defaultName,
          referer: it.referer || location.href,
          threads: parseInt(dlg.querySelector(".th").value, 10) || 4,
          remux: dlg.querySelector(".remux").checked,
          sanitize: dlg.querySelector(".sani").checked,
          start: dlg.querySelector(".start").checked,
          ts: Date.now(),
        };
        els.mask.classList.remove("on");
        await dispatch(payload);
      };
    }

    async function dispatch(payload) {
      const inbox = await gm.getAsync("wd:inbox", []);
      const list = Array.isArray(inbox) ? inbox : [];
      list.push(payload);
      await gm.setAsync("wd:inbox", list);
      const home = getHomeUrl();
      const reach = await checkHome(home);
      if (!reach.ok) {
        toast(`下载器主页访问失败${reach.status ? "（HTTP " + reach.status + "）" : ""}，任务已存入收件箱：请在「设置」填写可访问的主页地址，打开后会自动接手`);
        return;
      }
      gm.openTab(`${home}${home.includes("#") ? "" : "#open=1"}`, false);
      toast("已派发到下载器主页，请在页面确认并开始下载");
    }

    function settingsDialog() {
      els.mask.classList.add("on");
      els.mask.innerHTML = "";
      const dlg = document.createElement("div");
      dlg.className = "dialog";
      const saved = gm.get("wd3:home", "");
      dlg.innerHTML = `
        <h3>⚙ 脚本设置</h3>
        <div class="row"><span class="k">主页地址</span><input type="text" class="home" placeholder="${esc(getHomeUrl())}" value="${esc(saved)}"></div>
        <div class="row"><span class="k"></span><button class="tiny test">检测可达性</button><span class="sub status check"></span></div>
        <div class="row"><span class="k">生效地址</span><span class="path" title="${esc(getHomeUrl())}">${esc(getHomeUrl())}</span></div>
        <div class="row"><span class="k">保存路径</span><span class="path" title="${esc(savePathText())}">${esc(savePathText())}</span></div>
        <div class="row"><span class="k"></span><span class="sub">主页地址留空则使用最近打开过的下载器主页；下载器还未发布到 GitHub Pages 时，可填写本地或自建地址。保存路径只在主页下载器的「设置」里修改。</span></div>
        <div class="ops2"><button class="cancel">取消</button><button class="tiny reset">恢复自动</button><button class="primary ok">保存</button></div>`;
      els.mask.appendChild(dlg);
      const close = () => els.mask.classList.remove("on");
      dlg.querySelector(".cancel").onclick = close;
      els.mask.onclick = (e) => { if (e.target === els.mask) close(); };
      const input = dlg.querySelector(".home");
      const mark = (text, cls) => {
        const el = dlg.querySelector(".check");
        if (!el) return;
        el.className = `sub status check ${cls || ""}`;
        el.textContent = text;
      };
      dlg.querySelector(".test").onclick = async () => {
        const url = normalizeHome(input.value) || getHomeUrl();
        if (!url) { mark("地址不合法", "err"); return; }
        mark("检测中…");
        const r = await checkHome(url, true);
        mark(r.ok ? (r.status === -1 ? "可访问（已跳过检测）" : `可访问（HTTP ${r.status}）`) : (r.status ? `不可访问：HTTP ${r.status}` : "不可访问：网络错误"), r.ok ? "ok" : "err");
      };
      dlg.querySelector(".reset").onclick = () => {
        gm.set("wd3:home", "");
        close();
        toast("已恢复使用下载器主页上报的地址");
      };
      dlg.querySelector(".ok").onclick = async () => {
        const url = normalizeHome(input.value);
        if (url === null) { mark("地址不合法", "err"); return; }
        gm.set("wd3:home", url);
        close();
        if (!url) { toast("已恢复使用下载器主页上报的地址"); return; }
        const r = await checkHome(url, true);
        toast(r.ok ? `已保存主页地址：${url}` : `已保存，但地址不可访问${r.status ? "（HTTP " + r.status + "）" : ""}`);
      };
    }

    function toast(text) {
      const t = document.createElement("div");
      t.className = "toast";
      t.textContent = text;
      els.toasts.appendChild(t);
      setTimeout(() => t.remove(), 4000);
    }

    function copyText(text) {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.cssText = "position:fixed;left:-9999px;";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch { /* 忽略 */ }
      ta.remove();
    }

    ui = {
      add() { render(); },
      render() { render(); },
      toast(text) { toast(text); },
      renderSettings() { /* 弹窗打开时才读取设置，无需重绘 */ },
    };

    // 载入本页已发现的资源（同一标签页内）
    gm.getAsync("wd:sniff", []).then(list => {
      if (Array.isArray(list)) {
        const known = new Set(sniffList.map(s => s.url));
        for (const s of list) if (!known.has(s.url)) sniffList.push(s);
        render();
      }
    });

    // 接收子 iframe 上报
    addEventListener("message", (e) => {
      if (e.data && e.data.type === MSG_SNIFF && e.data.item) {
        const it = e.data.item;
        if (!sniffList.some(s => s.url === it.url)) { sniffList.unshift(it); render(); }
      }
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function log(...a) {
    if (gm.get("wd3:debug", false)) console.log("[Web下载器]", ...a);
  }

  // ============================================================
  // 启动
  // ============================================================
  if (!isHome) {
    patchNetwork();
    if (document.body) initUI(); else addEventListener("DOMContentLoaded", initUI);
    patchDom();
    refreshSettings();
    setInterval(refreshSettings, 8000);
  } else {
    log("主页模式：仅注入 GM 跨域桥");
  }
})();
