// m3u8 解析：master/media 播放列表、AES-128 解密、byterange、init 分片
import { getArrayBuffer, getText } from "./net.js";

export class PlaylistError extends Error {
  constructor(msg) { super(msg); this.name = "PlaylistError"; }
}

function resolve(base, ref) {
  return new URL(ref, base).href;
}

// 播放列表 query 令牌继承：部分站点把鉴权参数放在 m3u8 上，分片需带上
// 只对本身没有 query 的分片生效，已带独立签名的分片保持原样
function inheritQuery(baseUrl, segUrl) {
  try {
    const s = new URL(segUrl);
    if (!s.search && new URL(baseUrl).search) {
      s.search = new URL(baseUrl).search;
      return s.href;
    }
  } catch { /* 保持原样 */ }
  return segUrl;
}

export function parsePlaylist(text, baseUrl) {
  const body = text.replace(/^\uFEFF/, "");
  if (!/^\s*#EXTM3U/m.test(body.slice(0, 256))) {
    throw new PlaylistError("不是有效的 m3u8 播放列表");
  }
  const lines = body.split(/\r?\n/);
  const variants = [];
  const segments = [];
  const keys = [];
  const keyIndex = new Map();
  let map = null;
  let pendingKey = null;
  let pendingMap = null;
  let pendingByterange = null;
  let pendingDuration = null;
  let mediaSequence = 0;
  let ended = false;

  const addKey = (attrs) => {
    const method = (attrs.METHOD || "NONE").replace(/"/g, "");
    if (method === "NONE") { pendingKey = null; return; }
    const uri = attrs.URI ? inheritQuery(baseUrl, resolve(baseUrl, attrs.URI.replace(/^"|"$/g, ""))) : null;
    const sig = `${method}|${uri || ""}|${attrs.IV || ""}`;
    let idx = keyIndex.get(sig);
    if (idx === undefined) {
      idx = keys.length;
      keys.push({ method, uri, iv: attrs.IV ? attrs.IV.replace(/^0x/i, "") : null });
      keyIndex.set(sig, idx);
    }
    pendingKey = idx;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    if (raw.startsWith("#")) {
      const m = raw.match(/^#EXT-([A-Z-]+)(?::(.*))?$/i);
      const tag = m ? m[1].toUpperCase() : "";
      const val = m ? (m[2] || "") : "";
      if (tag === "X-STREAM-INF") {
        const attrs = parseAttrs(val);
        const next = lines.slice(i + 1).find(l => l.trim() && !l.trim().startsWith("#"));
        if (next) {
          variants.push({
            url: inheritQuery(baseUrl, resolve(baseUrl, next.trim())),
            bandwidth: parseInt(attrs.BANDWIDTH || "0", 10),
            resolution: attrs.RESOLUTION || "",
            codecs: attrs.CODECS || "",
            name: `${attrs.RESOLUTION || ""}${attrs.CODECS ? " " + attrs.CODECS : ""}`.trim() || `${Math.round((attrs.BANDWIDTH || 0) / 1000)} kbps`,
          });
        }
      } else if (tag === "X-KEY") {
        addKey(parseAttrs(val));
      } else if (tag === "X-MAP") {
        const attrs = parseAttrs(val);
        pendingMap = attrs.URI ? { url: inheritQuery(baseUrl, resolve(baseUrl, attrs.URI.replace(/^"|"$/g, ""))), byterange: attrs.BYTERANGE || null } : null;
      } else if (tag === "X-BYTERANGE") {
        pendingByterange = val;
      } else if (tag === "X-MEDIA-SEQUENCE") {
        mediaSequence = parseInt(val, 10) || 0;
      } else if (tag === "X-ENDLIST") {
        ended = true;
      } else if (tag === "INF") {
        const num = parseFloat(val.split(",")[0]);
        pendingDuration = isNaN(num) ? 0 : num;
      }
      continue;
    }

    // 资源行
    const url = inheritQuery(baseUrl, resolve(baseUrl, raw));
    if (variants.length && !segments.length && i > 0 && lines.slice(0, i).some(l => l.startsWith("#EXT-X-STREAM-INF"))) {
      // master 中已被 EXT-X-STREAM-INF 捕获的 URI 直接跳过（上面已记录）
    }
    segments.push({
      url,
      duration: pendingDuration || 0,
      key: pendingKey,
      map: pendingMap || map,
      byterange: pendingByterange,
      seq: mediaSequence + segments.length,
    });
    if (pendingMap && !map) map = pendingMap;
    pendingDuration = null;
    pendingByterange = null;
  }

  // master：去掉被 STREAM-INF 占位用的 URI 重复项
  if (variants.length && segments.length) {
    const variantUrls = new Set(variants.map(v => v.url));
    const kept = segments.filter(s => !variantUrls.has(s.url));
    if (kept.length === 0) segments.length = 0;
    else segments.splice(0, segments.length, ...kept);
  }

  const totalDuration = segments.reduce((a, s) => a + s.duration, 0);
  return {
    kind: variants.length && !segments.length ? "master" : segments.length ? "media" : "unknown",
    url: baseUrl,
    variants,
    segments,
    keys,
    duration: totalDuration,
    ended,
  };
}

function parseAttrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)\s*=\s*("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[3] !== undefined ? m[3] : m[2].trim();
  return out;
}

// 拉取播放列表；master 时按带宽挑选清晰度
export async function loadManifest(url, { referer, headers, preferBandwidth = 0 } = {}) {
  const r = await getText(url, { referer, headers });
  const manifest = parsePlaylist(r.body, url);
  if (manifest.kind === "master") {
    if (!manifest.variants.length) throw new PlaylistError("master 播放列表中没有可选码率");
    const sorted = [...manifest.variants].sort((a, b) => b.bandwidth - a.bandwidth);
    const chosen = preferBandwidth
      ? sorted.reduce((best, v) => Math.abs(v.bandwidth - preferBandwidth) < Math.abs(best.bandwidth - preferBandwidth) ? v : best, sorted[0])
      : sorted[0];
    const sub = await loadManifest(chosen.url, { referer, headers });
    sub.variants = manifest.variants;
    sub.chosen = chosen;
    sub.masterUrl = url;
    return sub;
  }
  if (manifest.kind === "unknown") throw new PlaylistError("无法解析的播放列表");
  return manifest;
}

// ---------- AES-128 解密 ----------
const keyCache = new Map();

async function fetchKeyBytes(uri, { referer, headers }) {
  const cacheKey = uri;
  if (keyCache.has(cacheKey)) return keyCache.get(cacheKey);
  const r = await getArrayBuffer(uri, { referer, headers });
  const buf = r.body instanceof ArrayBuffer ? r.body : await r.body.arrayBuffer();
  if (buf.byteLength !== 16) throw new PlaylistError(`密钥长度异常：${buf.byteLength} 字节`);
  keyCache.set(cacheKey, buf);
  return buf;
}

async function importKey(uri, opts) {
  const sig = uri;
  if (keyCache.has(sig + "|cryptokey")) return keyCache.get(sig + "|cryptokey");
  const raw = await fetchKeyBytes(uri, opts);
  const ck = await crypto.subtle.importKey("raw", raw, "AES-CBC", false, ["decrypt"]);
  keyCache.set(sig + "|cryptokey", ck);
  return ck;
}

function ivBytes(hex, seq) {
  if (hex) {
    const clean = hex.replace(/[^0-9a-f]/gi, "").padStart(32, "0");
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    return out;
  }
  // 默认 IV 为媒体序号的大端 16 字节表示
  const out = new Uint8Array(16);
  const dv = new DataView(out.buffer);
  dv.setUint32(12, seq >>> 0);
  return out;
}

export async function decryptSegment(data, key, seq, opts = {}) {
  if (!key || key.method === "NONE") return data;
  if (key.method === "SAMPLE-AES" || key.method.startsWith("SAMPLE")) {
    throw new PlaylistError("SAMPLE-AES 加密无法在浏览器内解密，请用源站播放器下载");
  }
  if (key.method !== "AES-128") throw new PlaylistError(`不支持的加密方式：${key.method}`);
  if (!key.uri) throw new PlaylistError("缺少密钥地址");
  const ck = await importKey(key.uri, opts);
  const iv = ivBytes(key.iv, seq);
  const plain = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, ck, data);
  return new Uint8Array(plain);
}
