# Web下载器 · 统一主页（v3.1）

m3u8 嗅探 + 多线程分片下载 + 断点续传 + TS 转封装 MP4。架构是两端：

- **油猴脚本**（`userscript/web-downloader.user.js`）装在任意站点，负责嗅探、悬浮球、任务确认，并把任务派发到本页。
- **本页**（统一主页下载器）负责真正下载：N 线程 Range 分片、分段直写本地文件、断点续传、任务管理、ffmpeg.wasm 无损转封装 MP4。

## 地址

- 下载器主页：<https://cat-x.github.io/web-download/>
- 安装脚本：<https://cat-x.github.io/web-download/userscript/web-downloader.user.js>

安装脚本后打开主页一次，脚本会自动记住该地址；也可在脚本悬浮球面板 →「设置」里手填主页地址并点「检测可达性」。派发前脚本会先探测主页是否可达，不可达时任务仍留在收件箱（`wd:inbox`），等主页打开后自动接手。

## 使用

1. Chrome 需在 `chrome://extensions` 打开「开发者模式」，否则用户脚本不生效。
2. 装脚本 → 打开主页 → 「选择文件夹」授权（可选）：授权后分片直写本地文件，不授权则用 IndexedDB 缓存、完成后点「另存」。
3. 在视频站点嗅探到资源 → 悬浮球里点「下载」→ 确认框可改文件名/线程数/转 MP4，并显示当前保存路径。

## 与 cat-x/web-downloader 的区别

老仓库是 v2.9.3 架构：下载在资源所在页面执行，主页只是只读总览面板。本仓库是 v3.1 架构：下载统一在主页执行，站点端只嗅探和派发。两者独立发布，可并存。

## 再发布

站点文件来自开发目录 `web_download/web/`，脚本来自 `web_download/userscript/`：

```bash
rsync -a --delete --exclude .DS_Store <开发目录>/web/ <本仓库>/
mkdir -p <本仓库>/userscript && cp <开发目录>/userscript/web-downloader.user.js <本仓库>/userscript/
```

本地验证：`node dev/serve.mjs` 后访问 `http://localhost:8123/`，夹具（普通/加密/master m3u8、Range 大文件）在 `dev/fixture/`，请求日志写 `dev/requests.log`。
