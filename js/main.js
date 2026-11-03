// 主页入口：装配引擎、界面与嗅探派发
import { Manager, Task } from "./engine.js";
import { UI } from "./ui.js";
import { kvGet, kvSet, handleGet, handlePut, handleDel, requestPersist } from "./db.js";
import { pickDirectory, verifyPermission, fsSupported } from "./writer.js";
import { bridge, hasBridge, bridgeKvGet, bridgeKvSet } from "./net.js";
import { setDebug, log, VERSION, uid } from "./util.js";

const DEFAULTS = {
  threads: 4,
  chunkMB: 4,
  maxConcurrentTasks: 2,
  autoSave: false,
  remuxMp4: true,
  sanitizeName: true,
  debugLog: false,
  backend: "idb",
  dirName: "",
  subDir: "",
  homeUrl: location.href.split("#")[0],
  proxy: "",
  sniffEnabled: true,
  bubble: true,
  popup: true,
};

let settings = { ...DEFAULTS };
let ui, manager;

async function loadSettings() {
  const saved = await kvGet("settings", {});
  settings = { ...DEFAULTS, ...saved };
  setDebug(settings.debugLog);
  if (settings.backend === "fs") {
    const h = await handleGet("dir");
    if (h && await verifyPermission(h, false) === "granted") settings.dirName = h.name;
    else { settings.backend = "idb"; settings.dirName = ""; }
  }
}

async function saveSettings(patch = {}) {
  Object.assign(settings, patch);
  await kvSet("settings", settings);
  setDebug(settings.debugLog);
  if (manager) manager.settings = settings;
  if (ui) { ui.settings = settings; ui.refreshDirUI(); }
}

// 供油猴脚本读取的设置（嗅探开关、悬浮球、主页地址）
async function pushSettingsToBridge() {
  if (!hasBridge()) return;
  await bridgeKvSet("wd:settings", { ...settings });
}

async function pickSaveDir() {
  if (!fsSupported()) { ui.toast("此浏览器不支持文件夹直写，改用 IndexedDB 缓存", "err"); return null; }
  const handle = await pickDirectory();
  if (!handle) return null;
  const perm = await verifyPermission(handle, true);
  if (perm !== "granted") { ui.toast("未获得文件夹写入权限", "err"); return null; }
  await handlePut("dir", handle);
  await saveSettings({ backend: "fs", dirName: handle.name });
  await pushSettingsToBridge();
  return handle;
}

async function clearSaveDir() {
  await handleDel("dir");
  await saveSettings({ backend: "idb", dirName: "" });
  await pushSettingsToBridge();
}

function detectKind(url) {
  try {
    const p = new URL(url, location.href).pathname.toLowerCase();
    return /\.(m3u8|m3u)$/.test(p) ? "hls" : "file";
  } catch { return "file"; }
}

function titleFromUrl(url) {
  try {
    const u = new URL(url, location.href);
    const last = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() || u.hostname);
    return last.replace(/\.[a-z0-9]{1,5}$/i, "");
  } catch { return "下载任务"; }
}

async function confirmAndAdd({ url, referer, title, filename, kind, start = true, threads, remux, sanitize, subDir }) {
  if (!/^https?:\/\//i.test(url)) { ui.toast("只支持 http(s) 地址", "err"); return; }
  const k = kind || detectKind(url);
  const chosen = await ui.openConfirm({
    url, kind: k,
    title: title || titleFromUrl(url),
    filename: filename || title || titleFromUrl(url),
    threads: threads || settings.threads,
    start, remux, sanitize, subDir,
  });
  if (!chosen) return;
  if (chosen.subDir !== settings.subDir) {
    await saveSettings({ subDir: chosen.subDir });
    await pushSettingsToBridge();
  }
  const record = Task.create({
    url, referer: referer || "", title: title || titleFromUrl(url),
    filename: chosen.filename, kind: k,
    remux: chosen.remux, sanitize: chosen.sanitize,
    threads: chosen.threads, backend: settings.backend, dirKey: "dir",
    subDir: chosen.subDir,
    start: chosen.start,
  }, settings);
  await manager.add(record);
  ui.toast(chosen.start ? "任务已开始下载" : "任务已加入暂停列表", "ok");
  ui.render();
}

// 手动添加
async function onAddUrl(raw) {
  const url = (raw || "").trim();
  if (!url) { ui.toast("请先粘贴下载地址", "err"); return; }
  ui.$("urlInput").value = "";
  await confirmAndAdd({ url, referer: location.href, start: true });
}

// ---------- 嗅探派发：hash 参数 或 GM 存储收件箱 ----------
async function readHashDispatch() {
  const hash = location.hash.slice(1);
  if (!hash) return;
  const params = new URLSearchParams(hash);
  const b64 = params.get("dispatch");
  if (b64) {
    try {
      const json = decodeURIComponent(escape(atob(b64)));
      const payload = JSON.parse(json);
      if (payload && payload.url) {
        await confirmAndAdd({
          url: payload.url, referer: payload.referer || "", title: payload.title || "",
          filename: payload.filename || "", kind: payload.kind, threads: payload.threads,
          remux: payload.remux, sanitize: payload.sanitize, start: payload.start !== false,
          subDir: payload.subDir,
        });
      }
    } catch (e) { log("解析派发参数失败:", e.message); }
  }
  history.replaceState(null, "", location.pathname + location.search);
}

async function pollInbox() {
  if (!hasBridge()) return;
  const inbox = await bridgeKvGet("wd:inbox", []);
  if (!Array.isArray(inbox) || !inbox.length) return;
  await bridgeKvSet("wd:inbox", []);
  for (const item of inbox) {
    if (item && item.url) {
      await confirmAndAdd({
        url: item.url, referer: item.referer || "", title: item.title || "",
        filename: item.filename || "", kind: item.kind, threads: item.threads,
        remux: item.remux, sanitize: item.sanitize, start: item.start !== false,
        subDir: item.subDir,
      });
    }
  }
}

async function pollSniff() {
  if (!hasBridge()) return;
  const list = await bridgeKvGet("wd:sniff", []);
  ui.setSniff((Array.isArray(list) ? list : []).map(s => ({ ...s, host: safeHost(s.referer || s.url) })));
}

function safeHost(u) {
  try { return new URL(u).host; } catch { return ""; }
}

async function onSniffAction(action, item) {
  if (action === "download") {
    await confirmAndAdd({ url: item.url, referer: item.referer || "", title: item.title || "", kind: item.kind });
    return;
  }
  let list = await bridgeKvGet("wd:sniff", []);
  if (!Array.isArray(list)) list = [];
  if (action === "clear") list = [];
  else if (action === "remove") list = list.filter(s => s.url !== item.url);
  await bridgeKvSet("wd:sniff", list);
  ui.setSniff(list.map(s => ({ ...s, host: safeHost(s.referer || s.url) })));
}

// ---------- 启动 ----------
async function boot() {
  document.getElementById("version").textContent = `v${VERSION}`;
  await loadSettings();
  requestPersist();

  manager = new Manager(settings, {
    onUpdate: () => ui.scheduleUpdate(),
    onList: () => ui.scheduleUpdate(),
    toast: (t, k) => ui.toast(t, k),
  });
  ui = new UI({
    manager,
    settings,
    onSettingsChange: async (s, force) => { await saveSettings(s); await pushSettingsToBridge(); if (force) ui.render(); },
    onSaveDir: pickSaveDir,
    onAddUrl,
    onDispatch: onSniffAction,
  });

  await manager.load();
  ui.render();
  await pushSettingsToBridge();
  await readHashDispatch();
  await pollInbox();
  await pollSniff();

  setInterval(() => { pollInbox(); pollSniff(); }, 3000);

  window.addEventListener("beforeunload", () => {
    for (const t of manager.tasks.values()) if (t.running) { t.pause(); }
  });

  log("Web下载器主页就绪", { bridge: hasBridge(), fs: fsSupported(), backend: settings.backend });
  if (!hasBridge()) {
    ui.toast("未检测到油猴脚本，跨站点分片可能被浏览器拦截；请安装 Web下载器 脚本", "err");
  }
}

boot().catch(e => {
  log("启动失败:", e.message);
  document.getElementById("list").innerHTML = `<div class="empty">启动失败：${e.message}</div>`;
});
