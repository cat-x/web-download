// TS → MP4 无损转封装：按需联网加载 ffmpeg.wasm 单线程核心，并缓存到 Cache Storage
import { log } from "./util.js";

const CDN_LIST = [
  "https://cdn.jsdelivr.net/npm",
  "https://unpkg.com",
];
const FFMPEG_VER = "@ffmpeg/ffmpeg@0.12.10";
const CORE_VER = "@ffmpeg/core@0.12.10";
const CACHE_NAME = "wd-ffmpeg-core";

let ffmpegInstance = null;
let loadingPromise = null;
// 记录真正可用的 CDN，核心文件与主脚本必须同源，否则某个节点被墙时核心仍会卡死
let activeBase = CDN_LIST[0];

function timeoutFetch(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

function loadScript(src, ms = 20000) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    const timer = setTimeout(() => {
      s.remove();
      reject(new Error(`脚本加载超时：${src}`));
    }, ms);
    s.src = src;
    s.onload = () => { clearTimeout(timer); resolve(); };
    s.onerror = () => { clearTimeout(timer); s.remove(); reject(new Error(`脚本加载失败：${src}`)); };
    document.head.appendChild(s);
  });
}

// 只加载 ffmpeg UMD（@ffmpeg/util 的 UMD 在无 CommonJS 环境下会抛 exports 未定义，故自带 toBlobURL）
async function ensureLibs() {
  if (window.FFmpegWASM) return;
  let lastErr;
  for (const base of CDN_LIST) {
    try {
      await loadScript(`${base}/${FFMPEG_VER}/dist/umd/ffmpeg.js`);
      if (window.FFmpegWASM) { activeBase = base; return; }
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("ffmpeg 组件加载失败");
}

async function toBlobURL(url) {
  const resp = await timeoutFetch(url, 120000);
  if (!resp.ok) throw new Error(`下载 ffmpeg 核心失败：HTTP ${resp.status}`);
  return URL.createObjectURL(await resp.blob());
}

// 核心文件较大（约 25MB），首次下载后放进 Cache Storage 复用
async function cachedBlobURL(url) {
  try {
    const cache = await caches.open(CACHE_NAME);
    const hit = await cache.match(url);
    if (hit) return URL.createObjectURL(await hit.blob());
  } catch { /* 非安全上下文或缓存不可用，直接联网 */ }
  const blob = await (await timeoutFetch(url, 120000)).blob();
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(url, new Response(blob));
  } catch { /* 配额不足时忽略缓存 */ }
  return URL.createObjectURL(blob);
}

export async function ensureFFmpeg(onStatus) {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    onStatus && onStatus("加载 ffmpeg 组件…");
    await ensureLibs();
    const { FFmpeg } = window.FFmpegWASM;
    const inst = new FFmpeg();
    // classWorkerURL 会以 {type:"module"} 创建 worker，模块 worker 没有 importScripts，
    // 只能走 import(coreURL) 分支取 default 导出 —— 因此核心必须用 ESM 版（UMD 版无 default export）
    const base = `${CDN_LIST[0]}/${CORE_VER}/dist/esm`;
    // worker 必须以同源 blob 形式提供：直接引用 CDN 上的 chunk 会被浏览器按跨源脚本拒绝
    const workerBase = `${CDN_LIST[0]}/${FFMPEG_VER}/dist/umd`;
    let coreURL, wasmURL, classWorkerURL;
    try {
      coreURL = await cachedBlobURL(`${base}/ffmpeg-core.js`);
      wasmURL = await cachedBlobURL(`${base}/ffmpeg-core.wasm`);
      classWorkerURL = await cachedBlobURL(`${workerBase}/814.ffmpeg.js`);
    } catch (e) {
      log("缓存 ffmpeg 核心失败，改用直连:", e.message);
      coreURL = await toBlobURL(`${base}/ffmpeg-core.js`);
      wasmURL = await toBlobURL(`${base}/ffmpeg-core.wasm`);
      classWorkerURL = await toBlobURL(`${workerBase}/814.ffmpeg.js`);
    }
    onStatus && onStatus("初始化 ffmpeg…");
    const ok = await inst.load({ coreURL, wasmURL, classWorkerURL });
    if (!ok) throw new Error("ffmpeg 初始化失败");
    URL.revokeObjectURL(coreURL);
    URL.revokeObjectURL(wasmURL);
    ffmpegInstance = inst;
    return inst;
  })().catch(e => { loadingPromise = null; throw e; });
  return loadingPromise;
}

export async function remuxTsToMp4(input, onProgress, onStatus) {
  const inst = await ensureFFmpeg(onStatus);
  const data = input instanceof Blob ? new Uint8Array(await input.arrayBuffer()) : input;
  inst.on("log", ({ message }) => log("ffmpeg:", message));
  inst.on("progress", ({ progress }) => onProgress && onProgress(Math.max(0, Math.min(1, progress))));
  await inst.deleteFile("in.ts").catch(() => {});
  await inst.deleteFile("out.mp4").catch(() => {});
  await inst.writeFile("in.ts", data);
  const code = await inst.exec([
    "-y", "-fflags", "+genpts", "-i", "in.ts",
    "-c", "copy", "-bsf:a", "aac_adtstoasc",
    "-movflags", "+faststart", "out.mp4",
  ]);
  if (code !== 0) {
    await inst.deleteFile("in.ts").catch(() => {});
    throw new Error(`转封装退出码 ${code}`);
  }
  const out = await inst.readFile("out.mp4");
  await inst.deleteFile("in.ts").catch(() => {});
  await inst.deleteFile("out.mp4").catch(() => {});
  const blob = out instanceof Uint8Array ? new Blob([out], { type: "video/mp4" }) : new Blob([out], { type: "video/mp4" });
  if (!blob.size) throw new Error("转封装结果为空");
  return blob;
}

export function ffmpegReady() {
  return !!ffmpegInstance;
}
