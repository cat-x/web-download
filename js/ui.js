// 界面渲染：任务列表、设置、确认弹窗、嗅探列表、toast、日志面板
import { fmtBytes, fmtSpeed, fmtEta, fmtDuration, dumpLogs, log } from "./util.js";
import { fsSupported } from "./writer.js";
import { hasBridge } from "./net.js";

const STATE_TEXT = {
  queued: "排队中",
  downloading: "下载中",
  paused: "已暂停",
  error: "失败",
  done: "已完成",
  converting: "转封装中",
};

export class UI {
  constructor({ manager, settings, onSettingsChange, onSaveDir, onAddUrl, onDispatch }) {
    this.manager = manager;
    this.settings = settings;
    this.tab = "active";
    this.rows = new Map();
    this.sniff = [];
    this.cb = { onSettingsChange, onSaveDir, onAddUrl, onDispatch };
    this.$ = (id) => document.getElementById(id);
    this.pendingUpdate = false;
    this.bind();
  }

  bind() {
    const $ = this.$;
    $("toggleSettings").onclick = () => { $("settings").hidden = !$("settings").hidden; };
    $("toggleLog").onclick = () => { $("logpanel").hidden = !$("logpanel").hidden; };
    $("logClear").onclick = () => { this.$("logBody").textContent = ""; };
    $("logCopy").onclick = () => {
      const text = this.diagnostic();
      navigator.clipboard.writeText(text).then(() => this.toast("诊断报告已复制", "ok"), () => this.toast("复制失败", "err"));
    };
    document.addEventListener("wd:log", (e) => {
      if (!$("logpanel").hidden) {
        $("logBody").textContent += `${e.detail}\n`;
        $("logBody").scrollTop = $("logBody").scrollHeight;
      }
    });

    $("addTask").onclick = () => this.cb.onAddUrl && this.cb.onAddUrl($("urlInput").value.trim());
    $("urlInput").addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.cb.onAddUrl && this.cb.onAddUrl($("urlInput").value.trim());
    });

    document.querySelectorAll(".tab").forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");
        this.tab = btn.dataset.tab;
        this.render();
      };
    });

    // 设置项
    const num = (id, key, min, max) => {
      const el = $(id);
      el.value = this.settings[key];
      el.onchange = () => {
        const v = Math.max(min, Math.min(max, parseInt(el.value, 10) || min));
        el.value = v;
        this.settings[key] = v;
        this.cb.onSettingsChange(this.settings);
      };
    };
    num("s_threads", "threads", 1, 16);
    num("s_chunkMB", "chunkMB", 1, 64);
    num("s_maxTasks", "maxConcurrentTasks", 1, 8);
    const chk = (id, key) => {
      const el = $(id);
      el.checked = !!this.settings[key];
      el.onchange = () => { this.settings[key] = el.checked; this.cb.onSettingsChange(this.settings); };
    };
    chk("s_autoSave", "autoSave");
    chk("s_remux", "remuxMp4");
    chk("s_sanitize", "sanitizeName");
    chk("s_debug", "debugLog");
    const txt = (id, key) => {
      const el = $(id);
      el.value = this.settings[key] || "";
      el.onchange = () => { this.settings[key] = el.value.trim(); this.cb.onSettingsChange(this.settings); };
    };
    txt("s_homeUrl", "homeUrl");
    txt("s_proxy", "proxy");
    $("s_save").onclick = () => { this.cb.onSettingsChange(this.settings, true); this.toast("设置已保存", "ok"); };

    $("s_pickDir").onclick = async () => {
      if (!fsSupported()) { this.toast("当前环境不支持直接写入文件夹，将使用浏览器下载", "err"); return; }
      const h = await this.cb.onSaveDir();
      if (h) { this.refreshDirUI(); this.toast(`已授权文件夹：${h.name}`, "ok"); }
    };
    $("s_clearDir").onclick = async () => {
      this.settings.backend = "idb";
      this.settings.dirName = "";
      await this.cb.onSaveDir(null);
      this.cb.onSettingsChange(this.settings, true);
      this.refreshDirUI();
    };
    this.refreshDirUI();

    $("opResumeAll").onclick = () => this.manager.resumeAll();
    $("opPauseAll").onclick = () => this.manager.pauseAll();
    $("opClearDone").onclick = () => this.manager.clearDone();
    $("opSaveAll").onclick = () => this.manager.saveAllDone();
    $("footHint").textContent = this.settings.backend === "fs"
      ? "分片直写本地文件 · 支持断点续传 / 更换地址续传"
      : "分片缓存于 IndexedDB · 支持断点续传 / 更换地址续传";

    $("confirmModal").querySelector("#cm_cancel").onclick = () => this.closeConfirm(null);
    $("confirmModal").querySelector("#cm_startBtn").onclick = () => this.closeConfirm(this.readConfirm());
    $("cm_pickDir").onclick = async () => {
      const h = await this.cb.onSaveDir();
      if (h) { $("cm_dir").textContent = h.name; this.updateConfirmPath(); }
    };
  }

  refreshDirUI() {
    const fs = this.settings.backend === "fs";
    this.$("s_dirName").textContent = fs ? (this.settings.dirName || "已授权文件夹") : "浏览器默认下载目录";
    this.$("s_clearDir").hidden = !fs;
    this.$("s_dirHint").textContent = fsSupported()
      ? (fs ? "分段直接写入本地占位文件，刷新后续传只补缺失分片" : "未选择文件夹，分片暂存 IndexedDB")
      : "此浏览器不支持文件夹直写（需 Chrome/Edge + https）";
    this.$("footHint").textContent = fs
      ? "分片直写本地文件 · 支持断点续传 / 更换地址续传"
      : "分片缓存于 IndexedDB · 支持断点续传 / 更换地址续传";
  }

  // ---------- 任务列表 ----------
  scheduleUpdate() {
    if (this.pendingUpdate) return;
    this.pendingUpdate = true;
    // 后台标签页会冻结 requestAnimationFrame，下载进度必须用定时器驱动
    setTimeout(() => { this.pendingUpdate = false; this.render(); this.updateCounts(); }, 250);
  }

  updateCounts() {
    const all = this.manager.list();
    const active = all.filter(t => ["queued", "downloading", "converting", "paused", "error"].includes(t.status));
    this.$("cActive").textContent = active.length;
    this.$("cDone").textContent = all.filter(t => t.status === "done").length;
    this.$("cAll").textContent = all.length;
    this.$("cSniff").textContent = this.sniff.length;
    const running = this.manager.runningCount();
    const badge = this.$("globalBadge");
    badge.textContent = running ? `↓ ${running} 个任务进行中` : "↓ 空闲";
    badge.className = `badge${running ? " busy" : ""}`;
    const engine = this.$("engineState");
    engine.textContent = hasBridge() ? "GM 代发引擎就绪" : (fsSupported() ? "直连引擎（未装脚本，跨域受限）" : "直连引擎（未装脚本）");
    engine.style.color = hasBridge() ? "var(--ok)" : "var(--warn)";
  }

  filterTasks() {
    const all = this.manager.list();
    if (this.tab === "active") return all.filter(t => t.status !== "done");
    if (this.tab === "done") return all.filter(t => t.status === "done");
    return all;
  }

  render() {
    const list = this.$("list");
    if (this.tab === "sniff") { this.renderSniffPanel(list); this.updateCounts(); return; }
    const tasks = this.filterTasks();
    if (!tasks.length) {
      list.innerHTML = `<div class="empty">${this.tab === "done" ? "暂无已完成任务" : "暂无任务，粘贴地址或从站点嗅探面板派发"}</div>`;
      for (const [, el] of this.rows) el.remove();
      this.rows.clear();
      this.updateCounts();
      return;
    }
    const keep = new Set(tasks.map(t => t.id));
    for (const [id, el] of this.rows) { if (!keep.has(id)) { el.remove(); this.rows.delete(id); } }
    const emptyEl = list.querySelector(".empty");
    if (emptyEl && tasks.length) emptyEl.remove();
    tasks.forEach((t, i) => {
      let el = this.rows.get(t.id);
      if (!el) { el = this.buildRow(t); this.rows.set(t.id, el); }
      const cur = list.children[i];
      if (cur !== el) list.insertBefore(el, cur || null);
      this.updateRow(el, t);
    });
    this.updateCounts();
  }

  buildRow(t) {
    const el = document.createElement("div");
    el.className = "task";
    el.dataset.id = t.id;
    el.innerHTML = `
      <div class="head">
        <span class="title"></span>
        <span class="tag"></span>
        <span class="state"></span>
      </div>
      <div class="bar"><i></i></div>
      <div class="meta">
        <span class="msg"></span>
        <span class="spacer"></span>
        <span class="acts"></span>
      </div>`;
    const acts = el.querySelector(".acts");
    const mk = (label, cls, fn) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.className = cls || "";
      b.onclick = (e) => { e.preventDefault(); fn(); };
      acts.appendChild(b);
      return b;
    };
    el.btnMain = mk("", "go", () => this.taskAction(t.id));
    mk("换址", "", () => this.changeUrl(t.id));
    mk("复制链接", "", () => this.copyUrl(t.id));
    mk("源地址", "", () => this.openSource(t.id));
    mk("删除", "danger", () => this.manager.remove(t.id));
    return el;
  }

  updateRow(el, t) {
    el.querySelector(".title").textContent = t.title || t.filename;
    const tag = el.querySelector(".tag");
    tag.textContent = t.kind === "hls" ? "m3u8" : "文件";
    tag.className = `tag${t.kind === "hls" ? "" : " file"}`;
    const state = el.querySelector(".state");
    state.textContent = STATE_TEXT[t.status] || t.status;
    state.className = `state ${t.status}`;

    const pct = t.totalUnits ? Math.min(100, (t.doneUnits / t.totalUnits) * 100) : (t.bytesTotal ? Math.min(100, t.bytesDone / t.bytesTotal * 100) : 0);
    const bar = el.querySelector(".bar");
    bar.className = `bar${t.status === "error" ? " error" : t.status === "done" ? " done" : ""}`;
    bar.querySelector("i").style.width = `${pct}%`;

    const parts = [];
    if (t.kind === "hls") parts.push(`分片 ${t.doneUnits}/${t.totalUnits}`);
    else parts.push(`${fmtBytes(t.bytesDone)}/${fmtBytes(t.bytesTotal)}`);
    if (t.bytesDone) parts.push(fmtBytes(t.bytesDone));
    if (t.status === "downloading" && t.speed) {
      parts.push(fmtSpeed(t.speed));
      const left = t.bytesTotal - t.bytesDone;
      if (left > 0) parts.push(`剩余 ${fmtEta(left / t.speed)}`);
    }
    if (t.duration) parts.push(fmtDuration(t.duration));
    if (t.backend === "fs") parts.push("本地文件直写");
    if (t.status === "done") {
      parts.push(t.outputName && t.outputName !== t.filename ? `已转 ${t.outputName}` : "已完成");
      if (t.msg) parts.push(t.msg);
    } else if (t.error) parts.push(t.error);
    else if (t.msg) parts.push(t.msg);
    el.querySelector(".msg").textContent = parts.join(" · ");

    const btn = el.btnMain;
    if (t.status === "downloading" || t.status === "queued" || t.status === "converting") {
      btn.textContent = "❙❙ 暂停"; btn.style.display = "";
      btn.onclick = () => this.manager.pause(t.id);
    } else if (t.status === "paused") {
      btn.textContent = "▶ 继续"; btn.style.display = "";
      btn.onclick = () => this.manager.resume(t.id);
    } else if (t.status === "error") {
      btn.textContent = "↻ 重试"; btn.style.display = "";
      btn.onclick = () => this.manager.retry(t.id);
    } else if (t.status === "done") {
      btn.textContent = "另存"; btn.style.display = "";
      btn.onclick = () => this.saveOne(t.id);
    }
  }

  taskAction(id) {
    const t = this.manager.get(id);
    if (!t) return;
    if (t.status === "paused") this.manager.resume(id);
    else this.manager.pause(id);
  }

  async saveOne(id) {
    const t = this.manager.get(id);
    if (!t) return;
    try {
      const name = await t.saveAs();
      this.toast(`已导出 ${name}`, "ok");
    } catch (e) {
      this.toast(`导出失败：${e.message}`, "err");
    }
  }

  async changeUrl(id) {
    const t = this.manager.get(id);
    if (!t) return;
    const nu = prompt("输入新的资源地址（分片数一致时保留已下载进度）", t.url);
    if (!nu || nu === t.url) return;
    try {
      this.manager.pause(id);
      await t.changeUrl(nu.trim());
      this.toast("地址已更新，继续下载将只补缺失分片", "ok");
      this.render();
    } catch (e) {
      this.toast(`换址失败：${e.message}`, "err");
    }
  }

  copyUrl(id) {
    const t = this.manager.get(id);
    if (!t) return;
    navigator.clipboard.writeText(t.url).then(() => this.toast("已复制链接", "ok"), () => this.toast("复制失败", "err"));
  }

  openSource(id) {
    const t = this.manager.get(id);
    if (!t) return;
    window.open(t.referer || t.url, "_blank");
  }

  // ---------- 嗅探 ----------
  setSniff(items) {
    this.sniff = items || [];
    this.updateCounts();
    if (this.tab === "sniff") this.render();
  }

  renderSniffPanel(list) {
    this.rows.clear();
    if (!this.sniff.length) {
      list.innerHTML = `<div class="empty">暂无嗅探记录。在视频站点点击悬浮球可派发任务到本页。</div>`;
      return;
    }
    list.innerHTML = `<div class="sniffbar">
        <span>共 ${this.sniff.length} 条，由油猴脚本在各站点收集（跨站点共享）</span>
        <span class="spacer"></span>
        <button class="ghost" id="sniffClear">清空全部</button>
      </div>`;
    this.$("sniffClear").onclick = () => this.cb.onDispatch && this.cb.onDispatch("clear");
    for (const s of this.sniff) {
      const row = document.createElement("div");
      row.className = "task";
      row.innerHTML = `
        <div class="head">
          <span class="title">${escapeHtml(s.title || "")}</span>
          <span class="tag${s.kind === "file" ? " file" : ""}">${s.kind === "file" ? "文件" : "m3u8"}</span>
          <span class="state">${s.duration ? fmtDuration(s.duration) : ""}</span>
        </div>
        <div class="meta">
          <span class="msg">${escapeHtml(s.host || "")} · ${escapeHtml(shortUrl(s.url))}</span>
          <span class="spacer"></span>
          <span class="acts"></span>
        </div>`;
      const acts = row.querySelector(".acts");
      const mk = (label, cls, fn) => {
        const b = document.createElement("button");
        b.textContent = label; b.className = cls || "";
        b.onclick = () => fn();
        acts.appendChild(b);
      };
      mk("下载", "go", () => this.cb.onDispatch && this.cb.onDispatch("download", s));
      mk("复制链接", "", () => navigator.clipboard.writeText(s.url).then(() => this.toast("已复制", "ok")));
      mk("打开源页", "", () => s.referer && window.open(s.referer, "_blank"));
      mk("移除", "danger", () => this.cb.onDispatch && this.cb.onDispatch("remove", s));
      list.appendChild(row);
    }
  }

  // ---------- 确认弹窗 ----------
  openConfirm(payload) {
    return new Promise(resolve => {
      const $ = this.$;
      this._confirmResolve = resolve;
      $("cm_url").textContent = payload.url;
      $("cm_url").title = payload.url;
      $("cm_name").value = payload.filename || payload.title || "";
      $("cm_threads").value = payload.threads || this.settings.threads || 4;
      $("cm_start").checked = payload.start !== false;
      // 派发/确认时带来的选择优先于全局设置
      $("cm_remux").checked = payload.remux !== undefined && payload.remux !== null
        ? !!payload.remux
        : (payload.kind === "hls" ? !!this.settings.remuxMp4 : false);
      $("cm_sanitize").checked = payload.sanitize !== undefined && payload.sanitize !== null
        ? !!payload.sanitize
        : this.settings.sanitizeName !== false;
      $("cm_dir").textContent = this.settings.backend === "fs" ? (this.settings.dirName || "已授权文件夹") : "浏览器默认下载目录";
      $("cm_subdir").value = payload.subDir != null ? payload.subDir : (this.settings.subDir || "");
      this.updateConfirmPath();
      $("cm_subdir").oninput = () => this.updateConfirmPath();
      $("confirmModal").hidden = false;
      $("cm_name").focus();
      $("cm_name").select();
    });
  }

  updateConfirmPath() {
    const $ = this.$;
    const sub = $("cm_subdir").value.trim().replace(/^[/\\]+|[/\\]+$/g, "");
    if (this.settings.backend === "fs") {
      const dir = this.settings.dirName || "已授权文件夹";
      $("cm_pathHint").textContent = sub ? `→ ${dir}/${sub}/` : `→ ${dir}/（未设置子目录，直接存于所选文件夹）`;
    } else {
      $("cm_pathHint").textContent = sub ? "子目录仅在「选择文件夹」直写模式下生效" : "未选择文件夹，完成后由浏览器另存";
    }
  }

  closeConfirm(result) {
    this.$("confirmModal").hidden = true;
    const r = this._confirmResolve;
    this._confirmResolve = null;
    if (r) r(result);
  }

  readConfirm() {
    const $ = this.$;
    return {
      filename: $("cm_name").value.trim(),
      threads: parseInt($("cm_threads").value, 10) || 4,
      subDir: $("cm_subdir").value.trim(),
      start: $("cm_start").checked,
      remux: $("cm_remux").checked,
      sanitize: $("cm_sanitize").checked,
    };
  }

  toast(text, kind = "") {
    const el = document.createElement("div");
    el.className = `toast ${kind}`;
    el.textContent = text;
    this.$("toasts").appendChild(el);
    setTimeout(() => el.remove(), 4200);
  }

  diagnostic() {
    const tasks = this.manager.list().map(t => ({
      id: t.id, kind: t.kind, status: t.status, url: t.url, referer: t.referer,
      filename: t.filename, total: t.totalUnits, done: t.doneUnits, bytes: t.bytesDone, error: t.error,
    }));
    return [
      `Web下载器 诊断报告 ${new Date().toISOString()}`,
      `UA: ${navigator.userAgent}`,
      `GM 桥: ${hasBridge()} · 文件夹直写: ${fsSupported()} · backend: ${this.settings.backend}`,
      `设置: ${JSON.stringify(this.settings)}`,
      `任务: ${JSON.stringify(tasks, null, 2)}`,
      `日志:\n${dumpLogs()}`,
    ].join("\n");
  }
}

function shortUrl(u) {
  try { const x = new URL(u); return x.pathname.length > 40 ? `…${x.pathname.slice(-36)}` : x.pathname; }
  catch { return String(u).slice(0, 50); }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
