// IndexedDB：任务记录、分片缓存、设置、目录句柄
import { log } from "./util.js";

const DB_NAME = "web-downloader";
const DB_VERSION = 2;

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("tasks")) {
        db.createObjectStore("tasks", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("chunks")) {
        const s = db.createObjectStore("chunks", { keyPath: ["taskId", "idx"] });
        s.createIndex("byTask", "taskId", { unique: false });
      }
      if (!db.objectStoreNames.contains("kv")) {
        db.createObjectStore("kv", { keyPath: "k" });
      }
      if (!db.objectStoreNames.contains("handles")) {
        db.createObjectStore("handles", { keyPath: "k" });
      }
      if (!db.objectStoreNames.contains("extras")) {
        db.createObjectStore("extras", { keyPath: "taskId" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error("transaction aborted"));
    if (req) req.onsuccess = () => resolve(req.result);
    else t.oncomplete = () => resolve();
  }));
}

// ---------- 任务 ----------
export const putTask = (task) => tx("tasks", "readwrite", s => s.put(task));
export const getTask = (id) => tx("tasks", "readonly", s => s.get(id));
export const allTasks = () => tx("tasks", "readonly", s => s.getAll());
export const delTask = (id) => tx("tasks", "readwrite", s => s.delete(id));

// ---------- 分片缓存（回退模式） ----------
export const chunkPut = (taskId, idx, blob) =>
  tx("chunks", "readwrite", s => s.put({ taskId, idx, blob }));
// 复合键读取需要精确数组
export function chunkFetch(taskId, idx) {
  return tx("chunks", "readonly", s => s.get([taskId, idx]));
}

export function chunkKeys(taskId) {
  return tx("chunks", "readonly", s => s.index("byTask").getAllKeys(taskId));
}

export function chunkDeleteTask(taskId) {
  return tx("chunks", "readwrite", s => {
    const cur = s.index("byTask").openCursor(taskId);
    cur.onsuccess = () => {
      const c = cur.result;
      if (c) { c.delete(); c.continue(); }
    };
  });
}

// ---------- 转封装产物（IDB 回退模式下缓存 MP4，避免重复转封装/误导出 TS） ----------
export const extraPut = (taskId, name, blob) =>
  tx("extras", "readwrite", s => s.put({ taskId, name, blob }));
export async function extraGet(taskId) {
  const r = await tx("extras", "readonly", s => s.get(taskId));
  return r ? r : null;
}
export const extraDel = (taskId) => tx("extras", "readwrite", s => s.delete(taskId));

// ---------- kv（设置 / 嗅探收件箱 / 临时值） ----------
export async function kvGet(key, def) {
  const r = await tx("kv", "readonly", s => s.get(key));
  return r === undefined || r === null ? def : r.v;
}
export const kvSet = (key, v) => tx("kv", "readwrite", s => s.put({ k: key, v }));
export const kvDel = (key) => tx("kv", "readwrite", s => s.delete(key));

// ---------- File System Access 句柄 ----------
export const handlePut = (key, handle) => tx("handles", "readwrite", s => s.put({ k: key, handle }));
export async function handleGet(key) {
  const r = await tx("handles", "readonly", s => s.get(key));
  return r ? r.handle : null;
}
export const handleDel = (key) => tx("handles", "readwrite", s => s.delete(key));

// ---------- 存储配额 ----------
export async function usageInfo() {
  if (!navigator.storage || !navigator.storage.estimate) return { usage: 0, quota: 0 };
  const e = await navigator.storage.estimate();
  return { usage: e.usage || 0, quota: e.quota || 0 };
}

export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) {
      const ok = await navigator.storage.persist();
      log("持久化存储授权:", ok);
      return ok;
    }
  } catch (e) { log("持久化存储申请失败:", e.message); }
  return false;
}

export async function wipeAll() {
  const db = await open();
  db.close();
  dbPromise = null;
  await new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = resolve;
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("数据库被其它页面占用，请先关闭其它标签页"));
  });
  log("已清空全部本地数据");
}
