// 下载引擎：任务规划、多线程分片调度、断点续传、落盘与转封装
import { getArrayBuffer, getRange, probe, NetError } from "./net.js";
import { loadManifest, decryptSegment, PlaylistError } from "./m3u8.js";
import { createWriter, verifyPermission, loadDirHandle } from "./writer.js";
import { putTask, delTask, allTasks, chunkDeleteTask, extraPut, extraDel } from "./db.js";
import {
  bitmapNew, bitmapGet, bitmapSet, uid, log,
  sanitizeName, baseNameOf, extOf, sleep,
} from "./util.js";

const MAX_UNIT_RETRY = 4;

// ---------- 资源规划 ----------
export async function plan(task) {
  const opts = { referer: task.referer || "", proxy: task.settings && task.settings.proxy };
  if (task.kind === "hls") {
    let manifest;
    try {
      manifest = await loadManifest(task.url, opts);
    } catch (e) {
      if (e instanceof PlaylistError) throw e;
      if (e instanceof NetError && !e.status) throw new Error(`无法访问播放列表：${e.message}`);
      throw new Error(`播放列表请求失败（HTTP ${e.status || 0}）`);
    }
    task.units = manifest.segments.map(s => ({
      u: s.url,
      k: s.key === null || s.key === undefined ? null : s.key,
      br: s.byterange || null,
      map: s.map ? s.map.url : null,
      seq: s.seq,
      d: s.duration,
    }));
    task.keys = manifest.keys;
    task.duration = manifest.duration;
    task.totalUnits = task.units.length;
    if (!task.totalUnits) throw new Error("播放列表中没有分片");
    task.ext = task.ext || "ts";
    task.mime = "video/mp2t";
    task.bytesTotal = 0;
    return task;
  }

  let info = { size: 0, acceptRanges: false, mime: "" };
  try {
    info = await probe(task.url, opts);
  } catch (e) { log("探测失败，按整体下载处理:", e.message); }
  task.mime = info.mime || task.mime || "";
  if (/\.m3u8?($|\?)/i.test(task.url) || (info.mime || "").includes("mpegurl")) {
    task.kind = "hls";
    return plan(task);
  }
  const chunk = Math.max(1, (task.settings && task.settings.chunkMB) || 4) * 1024 * 1024;
  if (!info.size) {
    task.units = [{ u: task.url }];
    task.bytesTotal = 0;
  } else {
    const n = Math.ceil(info.size / chunk);
    task.units = Array.from({ length: n }, (_, i) => ({
      u: task.url,
      off: i * chunk,
      end: Math.min(info.size, (i + 1) * chunk) - 1,
      size: Math.min(chunk, info.size - i * chunk),
    }));
    task.bytesTotal = info.size;
  }
  task.totalUnits = task.units.length;
  task.ext = task.ext || extOf(task.url) || "bin";
  return task;
}

// ---------- 单个下载任务 ----------
export class Task {
  constructor(record, settings, hooks = {}) {
    Object.assign(this, record);
    this.settings = settings;
    this.hooks = hooks;
    this.ctrl = null;
    this.running = false;
    this.bitmap = record.bitmap ? new Uint8Array(record.bitmap) : null;
    this.sizes = record.sizes || [];
    this.speed = 0;
    this.pendingData = {};
    this.commitCursor = 0;
    this.writeOffset = 0;
    this._bytesMark = 0;
    this._timeMark = Date.now();
    this._timer = null;
  }

  static create({ url, referer, title, filename, kind, remux, sanitize, threads, backend, dirKey, start = true }, settings = {}) {
    const id = uid();
    const ext = kind === "hls" ? "ts" : (extOf(url) || "bin");
    const base = filename || title || baseNameOf(url).replace(/\.[a-z0-9]{1,5}$/i, "") || `download-${Date.now()}`;
    return {
      id,
      kind,
      url,
      referer: referer || "",
      title: title || base,
      baseName: base,
      filename: `${sanitize === false ? base : sanitizeName(base)}.${ext}`,
      ext,
      remux: !!remux,
      sanitize: sanitize !== false,
      threads: threads || settings.threads || 4,
      backend: backend || "idb",
      dirKey: dirKey || "dir",
      status: start ? "queued" : "paused",
      totalUnits: 0,
      doneUnits: 0,
      bytesDone: 0,
      bytesTotal: 0,
      units: [],
      keys: [],
      sizes: [],
      bitmap: null,
      error: "",
      msg: "",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      finishedAt: 0,
      outputName: "",
    };
  }

  record() {
    const out = {};
    for (const k of ["id", "kind", "url", "referer", "title", "baseName", "filename", "ext", "remux", "sanitize",
      "threads", "backend", "dirKey", "status", "totalUnits", "bytesTotal", "units", "keys", "duration", "error", "msg",
      "createdAt", "updatedAt", "finishedAt", "outputName"]) {
      out[k] = this[k];
    }
    out.bitmap = this.bitmap ? Uint8Array.from(this.bitmap) : null;
    out.sizes = this.sizes.slice();
    out.doneUnits = Math.min(this.commitCursor || 0, this.totalUnits || 0);
    out.bytesDone = this.writeOffset || 0;
    out.updatedAt = Date.now();
    out.speed = this.speed;
    return out;
  }

  async persist() {
    if (this._timer) return;
    this._timer = setTimeout(async () => {
      this._timer = null;
      try { await putTask(this.record()); } catch (e) { log("任务持久化失败:", e.message); }
    }, 500);
  }

  async persistNow() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null; }
    try { await putTask(this.record()); } catch (e) { log("任务持久化失败:", e.message); }
  }

  emit(patch = {}) {
    Object.assign(this, patch);
    if (this.hooks.onUpdate) this.hooks.onUpdate(this);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.ctrl = new AbortController();
    this.attempts = {};
    this.emit({ status: "downloading", error: "", speed: 0 });
    await this.persistNow();
    try {
      if (!this.units || !this.units.length) {
        this.emit({ msg: "解析资源列表…" });
        await plan(this);
        this.bitmap = bitmapNew(this.totalUnits);
        this.sizes = Array.from({ length: this.totalUnits }, (_, i) => (this.kind === "file" && this.units[i].size) || 0);
        this.commitCursor = 0;
        this.writeOffset = 0;
        await this.persistNow();
      } else if (!this.bitmap) {
        this.bitmap = bitmapNew(this.totalUnits);
      }
      // 恢复续传位置：HLS 已写入的是连续前缀，直链分块可能不连续
      if (!this.commitCursor && this.bitmap) {
        this.commitCursor = 0;
        this.writeOffset = 0;
        if (this.kind === "file") {
          for (let i = 0; i < this.totalUnits; i++) {
            if (bitmapGet(this.bitmap, i)) {
              this.commitCursor++;
              this.writeOffset += this.sizes[i] || 0;
            }
          }
        } else {
          while (this.commitCursor < this.totalUnits && bitmapGet(this.bitmap, this.commitCursor)) {
            this.writeOffset += this.sizes[this.commitCursor] || 0;
            this.commitCursor++;
          }
        }
      }

      let dirHandle = null;
      if (this.backend === "fs") {
        dirHandle = await loadDirHandle(this.dirKey);
        const perm = await verifyPermission(dirHandle, false);
        if (perm !== "granted") {
          this.running = false;
          this.emit({ status: "paused", msg: "保存文件夹授权已失效，点击「继续」重新授权" });
          await this.persistNow();
          return;
        }
      }
      this.writer = await createWriter(this, { dirHandle, filename: this.filename });
      await this.writer.prepare({ totalSize: this.bytesTotal || 0 });

      if (this.commitCursor >= this.totalUnits) { await this.finalize(); return; }

      this.cursor = 0;
      this.inflight = new Set();
      this.emit({ msg: "" });
      const n = Math.max(1, Math.min(this.threads || 4, 16));
      const left = this.totalUnits - this.commitCursor;
      await Promise.all(Array.from({ length: Math.min(n, left) }, () => this.worker()));
      if (this.running) await this.finalize();
    } catch (e) {
      if (!this.running) return;
      const msg = e && e.code === "PERMISSION" ? "需要重新授权保存文件夹" : (e.message || "下载失败");
      log("任务失败:", this.filename, msg);
      this.running = false;
      if (this.writer) await this.disposeWriter();
      this.emit({ status: "error", error: msg, msg, speed: 0 });
      await this.persistNow();
    }
  }

  // 取下一个待下载分片下标；内存缓冲过多时等待顺序落盘
  async nextIndex() {
    while (this.running && this.ctrl && !this.ctrl.signal.aborted) {
      let i = -1;
      while (this.cursor < this.totalUnits) {
        const c = this.cursor++;
        if (bitmapGet(this.bitmap, c) || this.inflight.has(c)) continue;
        i = c; break;
      }
      if (i === -1) return this.inflight.size ? { wait: true } : null;
      if (Object.keys(this.pendingData).length > (this.threads || 4) * 3) {
        await sleep(120);
        continue;
      }
      this.inflight.add(i);
      return { i };
    }
    return null;
  }

  async worker() {
    while (this.running && this.ctrl && !this.ctrl.signal.aborted) {
      const slot = await this.nextIndex();
      if (!slot) return;
      if (slot.wait) { await sleep(150); continue; }
      const i = slot.i;
      try {
        const data = await this.downloadUnit(i);
        this.sizes[i] = data.byteLength;
        if (this.kind === "file") {
          await this.writer.write(i, this.units[i].off || 0, data);
          bitmapSet(this.bitmap, i, true);
          this.commitCursor++;
          this.writeOffset += data.byteLength;
        } else {
          this.pendingData[i] = data;
          await this.flushWritable();
        }
        this.inflight.delete(i);
        this.tickSpeed();
        this.emit({ doneUnits: Math.min(this.commitCursor, this.totalUnits), bytesDone: this.writeOffset });
        if (this.commitCursor % 20 === 0) this.persist();
      } catch (e) {
        this.inflight.delete(i);
        if (!this.running || (this.ctrl && this.ctrl.signal.aborted) || e.name === "AbortError") return;
        this.attempts[i] = (this.attempts[i] || 0) + 1;
        const tries = this.attempts[i];
        if (tries > MAX_UNIT_RETRY || e instanceof PlaylistError) {
          this.running = false;
          if (this.ctrl) this.ctrl.abort();
          const msg = e instanceof PlaylistError ? e.message : `第 ${i + 1} 个分片下载失败：${e.message}`;
          this.emit({ status: "error", error: msg, msg, speed: 0 });
          await this.persistNow();
          return;
        }
        const wait = Math.min(8000, 400 * 2 ** tries);
        log(`分片 ${i + 1} 第 ${tries} 次失败，${wait}ms 后重试:`, e.message);
        this.emit({ msg: `重试第 ${i + 1} 个分片（${tries}/${MAX_UNIT_RETRY}）…` });
        await sleep(wait);
      }
    }
  }

  async downloadUnit(i) {
    const unit = this.units[i];
    const opts = {
      referer: this.referer,
      signal: this.ctrl.signal,
      proxy: this.settings.proxy,
      headers: this.headers || {},
    };
    if (this.kind === "file") {
      const r = unit.off !== undefined && unit.end !== undefined
        ? await getRange(unit.u, unit.off, unit.end, opts)
        : await getArrayBuffer(unit.u, opts);
      return toBytes(r.body);
    }
    const r = await getArrayBuffer(unit.u, opts);
    let bytes = toBytes(r.body);
    if (unit.br) {
      const [n, o] = unit.br.split("@").map(x => parseInt(x, 10));
      bytes = bytes.slice(isNaN(o) ? 0 : o, (isNaN(o) ? 0 : o) + (isNaN(n) ? bytes.byteLength : n));
    }
    if (unit.k !== null && unit.k !== undefined && this.keys && this.keys[unit.k]) {
      bytes = await decryptSegment(bytes, this.keys[unit.k], unit.seq !== undefined ? unit.seq : i, { referer: this.referer, proxy: this.settings.proxy });
    }
    if (unit.map && i === 0) {
      try {
        const mr = await getArrayBuffer(unit.map, opts);
        bytes = concat(toBytes(mr.body), bytes);
      } catch (e) { log("init 分片获取失败:", e.message); }
    }
    return bytes;
  }

  // HLS 按序落盘：偏移依赖前序分片实际大小，缓冲到位即顺序写入。
  // 多个 worker 会并发调用，必须串成一条链，否则会重复写入同一分片并越过总数。
  flushWritable() {
    this._flushChain = (this._flushChain || Promise.resolve()).then(() => this._flushOnce());
    return this._flushChain;
  }

  async _flushOnce() {
    while (this.commitCursor < this.totalUnits && this.pendingData[this.commitCursor] !== undefined) {
      const i = this.commitCursor;
      const data = this.pendingData[i];
      await this.writer.write(i, this.writeOffset, data);
      this.writeOffset += data.byteLength;
      bitmapSet(this.bitmap, i, true);
      delete this.pendingData[i];
      this.commitCursor = i + 1;
    }
  }

  tickSpeed() {
    const now = Date.now();
    if (now - this._timeMark > 1000) {
      this.speed = Math.max(0, (this.writeOffset - this._bytesMark) * 1000 / (now - this._timeMark));
      this._bytesMark = this.writeOffset;
      this._timeMark = now;
    }
  }

  async finalize() {
    this.running = false;
    this.emit({ msg: "写入收尾…" });
    if (this.writer) { await this.writer.finalize(); this.writer = null; }
    this.outputName = this.filename;
    this.emit({ status: "done", doneUnits: this.totalUnits, bytesDone: this.writeOffset, speed: 0, msg: "", finishedAt: Date.now() });
    await this.persistNow();

    if (this.remux && this.kind === "hls") {
      try {
        const { remuxTsToMp4 } = await import("./remux.js");
        this.emit({ status: "converting", msg: "转封装 MP4 中…" });
        const src = await this.readOutput();
        const mp4 = await remuxTsToMp4(src, (p) => this.emit({ msg: `转封装 MP4 ${(p * 100) | 0}%` }));
        const name = `${this.baseName}.mp4`;
        this.outputName = name;
        await saveExtra(this, name, mp4);
        this.emit({ status: "done", msg: "已转封装 MP4" });
        await this.persistNow();
      } catch (e) {
        log("转封装失败，保留 TS:", e.message);
        this.emit({ status: "done", msg: `转封装失败（${e.message}），已保留 TS` });
        await this.persistNow();
      }
    }
    if (this.settings.autoSave && this.backend === "idb") {
      try { await this.saveAs(); } catch (e) { log("自动另存失败:", e.message); }
    }
  }

  async readOutput() {
    if (this.writer) return await this.writer.readOutput();
    const dirHandle = this.backend === "fs" ? await loadDirHandle(this.dirKey) : null;
    const w = await createWriter(this, { dirHandle, filename: this.outputName || this.filename });
    return await w.readOutput();
  }

  async saveAs() {
    const dirHandle = this.backend === "fs" ? await loadDirHandle(this.dirKey) : null;
    const w = await createWriter(this, { dirHandle, filename: this.outputName || this.filename });
    if (this.backend === "fs") await w.prepare({ totalSize: this.writeOffset });
    return await w.saveAs();
  }

  pause() {
    if (!this.running) return;
    this.running = false;
    if (this.ctrl) this.ctrl.abort();
    this.emit({ status: "paused", speed: 0, msg: "已暂停" });
    this.persistNow();
  }

  async disposeWriter() {
    if (this.writer) {
      try { await this.writer.finalize(); } catch { /* 关闭失败不影响状态 */ }
      this.writer = null;
    }
    this.pendingData = {};
  }

  // 更换地址续传：分片数一致时复用已下载进度
  async changeUrl(newUrl) {
    const oldUrl = this.url;
    const oldUnits = this.units, oldTotal = this.totalUnits, oldBitmap = this.bitmap, oldSizes = this.sizes;
    await this.disposeWriter();
    this.url = newUrl;
    this.units = [];
    this.keys = [];
    this.totalUnits = 0;
    try {
      await plan(this);
      if (oldTotal && oldTotal === this.totalUnits && oldBitmap) {
        // 分片数一致：沿用已下载进度，只替换后续分片地址
        this.bitmap = oldBitmap;
        this.sizes = oldSizes;
        this.commitCursor = 0;
        this.writeOffset = 0;
        while (this.commitCursor < this.totalUnits && bitmapGet(this.bitmap, this.commitCursor)) {
          this.writeOffset += this.sizes[this.commitCursor] || 0;
          this.commitCursor++;
        }
      } else {
        if (this.backend === "idb") { await chunkDeleteTask(this.id); await extraDel(this.id); }
        this.bitmap = bitmapNew(this.totalUnits);
        this.sizes = Array.from({ length: this.totalUnits }, () => 0);
        this.commitCursor = 0;
        this.writeOffset = 0;
      }
      this.emit({
        status: "paused", error: "", msg: "地址已更新，点击「继续」按新地址续传",
        doneUnits: Math.min(this.commitCursor, this.totalUnits), bytesDone: this.writeOffset, speed: 0,
      });
      await this.persistNow();
    } catch (e) {
      this.url = oldUrl;
      this.units = oldUnits;
      this.totalUnits = oldTotal;
      this.bitmap = oldBitmap;
      this.sizes = oldSizes;
      throw e;
    }
  }
}

function toBytes(body) {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  throw new Error("响应数据格式异常");
}

function concat(a, b) {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0); out.set(b, a.byteLength);
  return out;
}

async function saveExtra(task, name, blob) {
  if (task.backend === "fs") {
    const dir = await loadDirHandle(task.dirKey);
    if (!dir) throw new Error("保存文件夹不可用");
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    return;
  }
  await extraPut(task.id, name, blob);
}

// ---------- 任务管理器 ----------
export class Manager {
  constructor(settings, hooks = {}) {
    this.settings = settings;
    this.hooks = hooks;
    this.tasks = new Map();
  }

  async load() {
    const records = await allTasks();
    for (const r of records) {
      if (["downloading", "queued", "converting"].includes(r.status)) {
        r.status = "paused";
        r.msg = "页面刷新后已暂停，点击继续";
      }
      const t = new Task(r, this.settings, { onUpdate: (task) => this.hooks.onUpdate && this.hooks.onUpdate(task) });
      this.tasks.set(t.id, t);
    }
    if (this.hooks.onList) this.hooks.onList(this.list());
  }

  list() {
    return [...this.tasks.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id) { return this.tasks.get(id); }

  async add(record) {
    const t = new Task(record, this.settings, { onUpdate: (task) => this.hooks.onUpdate && this.hooks.onUpdate(task) });
    this.tasks.set(t.id, t);
    await t.persistNow();
    if (this.hooks.onList) this.hooks.onList(this.list());
    this.pump();
    return t;
  }

  pump() {
    const cap = Math.max(1, this.settings.maxConcurrentTasks || 2);
    const active = [...this.tasks.values()].filter(t => t.running).length;
    const waiting = [...this.tasks.values()]
      .filter(t => !t.running && t.status === "queued")
      .sort((a, b) => a.createdAt - b.createdAt);
    for (const t of waiting.slice(0, Math.max(0, cap - active))) {
      t.start().then(() => this.pump()).catch(e => log("调度异常:", e.message));
    }
  }

  async resume(id) {
    const t = this.tasks.get(id);
    if (!t || t.running) return;
    if (t.backend === "fs") {
      // 需在用户手势内请求文件夹授权
      const dir = await loadDirHandle(t.dirKey);
      const perm = await verifyPermission(dir, true);
      if (perm !== "granted") { this.hooks.toast && this.hooks.toast("未获得文件夹写入权限，改用浏览器下载", "err"); t.backend = "idb"; }
    }
    t.status = "queued";
    await t.persistNow();
    this.pump();
  }

  pause(id) {
    const t = this.tasks.get(id);
    if (!t) return;
    t.pause();
    t.disposeWriter();
    this.pump();
  }

  async retry(id) {
    const t = this.tasks.get(id);
    if (!t || t.running) return;
    t.error = "";
    t.status = "queued";
    await t.persistNow();
    this.pump();
  }

  pauseAll() {
    for (const t of this.tasks.values()) {
      if (t.running || t.status === "queued") { t.pause(); t.disposeWriter(); }
    }
    this.pump();
  }

  async resumeAll() {
    for (const t of this.tasks.values()) {
      if (t.status === "paused" || t.status === "error") await this.resume(t.id);
    }
  }

  async remove(id) {
    const t = this.tasks.get(id);
    if (!t) return;
    t.pause();
    await t.disposeWriter();
    if (t.backend === "idb") { await chunkDeleteTask(id); await extraDel(id); }
    this.tasks.delete(id);
    await delTask(id);
    if (this.hooks.onList) this.hooks.onList(this.list());
    this.pump();
  }

  async clearDone() {
    for (const t of this.list()) if (t.status === "done") await this.remove(t.id);
  }

  async saveAllDone() {
    let n = 0;
    for (const t of this.list()) {
      if (t.status !== "done") continue;
      try { await t.saveAs(); n++; await sleep(800); } catch (e) { log("另存失败:", t.filename, e.message); }
    }
    this.hooks.toast && this.hooks.toast(`已导出 ${n} 个任务`, n ? "ok" : "err");
  }

  runningCount() {
    return [...this.tasks.values()].filter(t => t.running).length;
  }
}
