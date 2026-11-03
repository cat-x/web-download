// 落盘后端：File System Access 分段直写（迅雷式占位文件）+ IndexedDB 分片缓存回退
import { handlePut, handleGet, handleDel, chunkPut, chunkKeys, chunkFetch, chunkDeleteTask, extraGet, extraDel } from "./db.js";
import { log } from "./util.js";

export function fsSupported() {
  return typeof window.showDirectoryPicker === "function" && window.isSecureContext;
}

export async function pickDirectory() {
  if (!fsSupported()) throw new Error("当前浏览器或页面环境不支持直接写入文件夹（需 Chrome/Edge + https 或 localhost）");
  try {
    return await window.showDirectoryPicker({ mode: "readwrite", id: "wd-dir", startIn: "downloads" });
  } catch (e) {
    if (e.name === "AbortError") return null;
    throw e;
  }
}

// 权限：granted / prompt（需用户手势） / denied
export async function verifyPermission(handle, ask = false) {
  if (!handle) return "none";
  const d = { mode: "readwrite" };
  if (await handle.queryPermission(d) === "granted") return "granted";
  if (ask && await handle.requestPermission) {
    const r = await handle.requestPermission(d);
    return r === "granted" ? "granted" : "denied";
  }
  return "prompt";
}

async function saveDirHandle(handle, key = "dir") {
  await handlePut(key, handle);
}

export async function loadDirHandle(key = "dir") {
  return await handleGet(key);
}

export async function dropDirHandle(key = "dir") {
  await handleDel(key);
}

// 任务级子目录：在已授权文件夹下按需创建；".." 被忽略，无法越出授权根目录
export async function resolveSubDir(base, subDir) {
  if (!base || !subDir) return base;
  let dir = base;
  for (const seg of String(subDir).split(/[\\/]+/)) {
    if (!seg || seg === "." || seg === "..") continue;
    dir = await dir.getDirectoryHandle(seg.replace(/[\u0000-\u001f:*?"<>|]/g, "_"), { create: true });
  }
  return dir;
}

// ---------- 统一写入接口 ----------
class BaseWriter {
  constructor(task) {
    this.task = task;
    this.backend = "base";
    this.filename = task.filename;
  }
  async prepare() { throw new Error("not implemented"); }
  async write() { throw new Error("not implemented"); }
  async finalize() {}
  async readOutput() { throw new Error("not implemented"); }
  async saveAs() { throw new Error("not implemented"); }
  async cleanup() {}
}

// File System Access：先建占位文件，边下边按偏移填充，完成不改动数据
class FsWriter extends BaseWriter {
  constructor(task, dirHandle, filename) {
    super(task);
    this.backend = "fs";
    this.dir = dirHandle;
    this.filename = filename;
    this.writable = null;
    this.fileHandle = null;
    this.queue = Promise.resolve();
    this.bytesWritten = 0;
  }

  async prepare({ totalSize = 0 } = {}) {
    const perm = await verifyPermission(this.dir, false);
    if (perm !== "granted") {
      const err = new Error("需要重新授权保存文件夹");
      err.code = "PERMISSION";
      throw err;
    }
    this.fileHandle = await this.dir.getFileHandle(this.filename, { create: true });
    await handlePut(`file:${this.task.id}`, this.fileHandle);
    // keepData：保留已写入内容，续传时只补缺失区间
    this.writable = await this.fileHandle.createWritable({ keepData: true });
    if (totalSize > 0 && this.writable.truncate) {
      // 预分配占位文件大小，让本地文件立刻呈现完整体积
      try { await this.writable.truncate(totalSize); } catch (e) { log("预分配失败:", e.message); }
    }
  }

  async writeAt(offset, data) {
    if (!this.writable) throw new Error("写入流未就绪");
    const chunk = data.slice ? data.slice(0) : data;
    this.queue = this.queue.then(async () => {
      if (!this.writable) return;
      await this.writable.seek(offset);
      await this.writable.write(chunk);
      this.bytesWritten += chunk.byteLength || chunk.length || 0;
    }).catch(e => { this.fail = e; });
    if (this.fail) throw this.fail;
    await this.queue;
    if (this.fail) throw this.fail;
  }

  async write(index, offset, data) {
    return this.writeAt(offset, data);
  }

  async finalize() {
    await this.queue;
    if (this.writable) {
      try { await this.writable.close(); } catch (e) { log("关闭写入流失败:", e.message); }
      this.writable = null;
    }
  }

  async readOutput() {
    // 按当前文件名取（转封装后文件名已变为 .mp4），取不到再回退到下载时的句柄
    let fh = null;
    try {
      fh = await this.dir.getFileHandle(this.filename);
    } catch {
      if (!this.fileHandle) this.fileHandle = await handleGet(`file:${this.task.id}`);
      fh = this.fileHandle;
    }
    if (!fh) throw new Error("找不到已保存的文件");
    return await fh.getFile();
  }

  // 已直写本地文件夹，另存只是再导出一份副本
  async saveAs() {
    const file = await this.readOutput();
    downloadBlob(file, this.filename);
    return file.name;
  }

  async outputName() { return this.filename; }
  async outputPathHint() {
    return `${(this.dir && this.dir.name) || "已授权文件夹"}/${this.filename}`;
  }
}

// IndexedDB：分片缓存，完成后按序合并再触发浏览器下载
class IdbWriter extends BaseWriter {
  constructor(task, filename) {
    super(task);
    this.backend = "idb";
    this.filename = filename;
    this.offsets = null;
  }

  async prepare() { /* 分片到达时写入 */ }

  async write(index, offset, data) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    await chunkPut(this.task.id, index, blob);
  }

  async assemble() {
    const keys = await chunkKeys(this.task.id);
    const map = new Map(keys.map(k => [k[1], true]));
    const parts = [];
    for (let i = 0; i < this.task.totalUnits; i++) {
      if (!map.has(i)) throw new Error(`第 ${i + 1} 个分片缺失`);
      const rec = await chunkFetch(this.task.id, i);
      parts.push(rec.blob);
    }
    return new Blob(parts, { type: this.task.mime || "application/octet-stream" });
  }

  async readOutput() {
    const ex = await extraGet(this.task.id);
    return ex ? ex.blob : await this.assemble();
  }

  async finalize() { /* 合并延后到 saveAs */ }

  async saveAs() {
    const ex = await extraGet(this.task.id);
    const blob = ex ? ex.blob : await this.assemble();
    const name = ex ? ex.name : this.filename;
    downloadBlob(blob, name);
    return name;
  }

  async outputName() { return this.filename; }
  async outputPathHint() { return "浏览器下载目录"; }

  async cleanup() {
    await chunkDeleteTask(this.task.id);
    await extraDel(this.task.id);
  }
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export async function createWriter(task, { dirHandle, filename }) {
  const name = filename || task.filename;
  if (task.backend === "fs" && dirHandle) {
    return new FsWriter(task, dirHandle, name);
  }
  return new IdbWriter(task, name);
}

// 供设置界面使用：写入到用户选定的目录（全局句柄）
export { saveDirHandle };
