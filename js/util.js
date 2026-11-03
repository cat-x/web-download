// 通用工具：格式化、文件名净化、位图、日志

export const VERSION = "3.0.0";

export function fmtBytes(n) {
  if (!n || n < 0) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 100 || i === 0 ? 0 : 1)} ${u[i]}`;
}

export function fmtSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return "--";
  return `${fmtBytes(bytesPerSec)}/s`;
}

export function fmtDuration(sec) {
  if (!sec || sec <= 0) return "";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  if (h) return `${h} 小时 ${m} 分`;
  if (m) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

export function fmtEta(sec) {
  if (!sec || sec <= 0 || !isFinite(sec)) return "";
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  return h ? `${h}h${m}m` : m ? `${m}m${s}s` : `${s}s`;
}

// 跨平台文件名修正：去掉 Windows/macOS 非法或易出问题的字符
export function sanitizeName(name) {
  return (name || "")
    .replace(/[\u0000-\u001f/\\:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/^\.+/, "")
    .trim()
    .slice(0, 180);
}

export function extOf(pathOrUrl) {
  try {
    const p = new URL(pathOrUrl, location.href).pathname;
    const m = p.match(/\.([a-z0-9]{1,5})$/i);
    return m ? m[1].toLowerCase() : "";
  } catch { return ""; }
}

export function baseNameOf(url) {
  try {
    const p = new URL(url).pathname;
    const last = decodeURIComponent(p.split("/").filter(Boolean).pop() || "");
    return last || "";
  } catch { return ""; }
}

// 稳定 id：用于缓存键，避免超长 URL 作为主键
export function strHash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0).toString(16) + (h1 >>> 0).toString(16);
}

export function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

// ---------- 分片完成位图 ----------
export function bitmapNew(size) {
  return new Uint8Array(Math.ceil(size / 8));
}
export function bitmapGet(bm, i) {
  return (bm[i >> 3] & (1 << (i & 7))) !== 0;
}
export function bitmapSet(bm, i, done) {
  const byte = i >> 3, bit = 1 << (i & 7);
  if (done) bm[byte] |= bit; else bm[byte] &= ~bit;
}
export function bitmapCount(bm) {
  let n = 0;
  for (let i = 0; i < bm.length; i++) {
    let v = bm[i];
    while (v) { v &= v - 1; n++; }
  }
  return n;
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}

export function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ---------- 日志 ----------
const logs = [];
let debugOn = false;
export function setDebug(on) { debugOn = !!on; }
export function log(...args) {
  const line = `[${new Date().toLocaleTimeString()}] ${args.map(a => typeof a === "string" ? a : safeStr(a)).join(" ")}`;
  logs.push(line);
  if (logs.length > 2000) logs.shift();
  if (debugOn) console.log("%cWD", "color:#35c3f0;font-weight:bold", ...args);
  document.dispatchEvent(new CustomEvent("wd:log", { detail: line }));
}
function safeStr(o) {
  try { return typeof o === "object" ? JSON.stringify(o).slice(0, 400) : String(o); }
  catch { return String(o); }
}
export function dumpLogs() { return logs.join("\n"); }
export function clearLogs() { logs.length = 0; }
