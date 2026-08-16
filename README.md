# 字谈 ZiTan · 听障沟通助手

本地大字笔谈，帮听障朋友与志愿者/路人快速沟通。**纯本地运行，内容不离开设备。**

- 单 HTML 应用（PWA）：中英双语、大字展示、快捷用语、TTS 朗读、对话历史
- **语音识别（ASR）**：志愿者说话 → 自动转文字填入输入框。**原生 Web Speech API 优先**（联网、零下载、秒开），**本地 SenseVoice 兜底**（离线、音频不出设备）
- 本地路径：SenseVoice-Small（228MB ONNX）+ onnxruntime-web（WASM）；联网原生路径调研见 `018`

> 部署方案速览见下；详细技术见 `004`，部署细节见 `006`，开源见 `005`。

---

## 快速开始（本地）

```bash
cd ZiTan
python3 -m http.server 8000
# 浏览器打开 http://127.0.0.1:8000/sensevoice-ort-test.html  ← 语音识别演示页
# 或 http://127.0.0.1:8000/index.html                        ← 主应用
```

> 必须用 HTTP 服务（wasm/fetch 不支持 `file://` 直开）。

## 语音识别演示页

| 页面 | 路线 | 说明 |
|---|---|---|
| `sensevoice-ort-test.html` | onnxruntime-web（推荐） | 模型加载 ~1s，识别 ~500ms，支持自动演示/上传/麦克风 |
| `sensevoice-test.html` | sherpa-onnx WASM | 017 原方案，模型打包在 .data |
| `speech-native-test.html` | **原生 Web Speech API（联网）** | 三大浏览器原生语音识别：检测 + 真人测试按钮，调研见 `018` |
| `cloud-asr-test.html` | **云端 API（第三条腿）** | 录音 → Worker 代理 → 讯飞/百度/Azure 云端识别，真人测试见 `019` |

模型文件在 `sensevoice/`（228MB `model.int8.onnx` + `tokens.txt` + `ort/` 运行时），首次访问自动加载。

---

## 部署方案：网站（Pages）+ 存储桶（R2）

### 架构

```
用户浏览器 ──▶ Cloudflare Pages（HTML/JS/CSS + Functions，<1MB 代码秒开）
            │     ├─ /sensevoice/* 由 Pages Function 拦截
            │     └─ env.MODELS（R2 binding）↘
            │                              ▼
            └▶ Cloudflare R2 bucket「wewalkworld-models」（model 228MB + ort wasm）
```

- **为什么拆**：Cloudflare Pages 单文件上限约 **25MB**，模型/引擎放不下 → 大资产放 **R2 对象存储**（无上限，支持 Range 断点续传）。
- **只部署 onnxruntime-web 路线**（README 主应用即此路线）：首载 ≈ 240MB（模型 228 + ort wasm），sherpa 路线已归档至 `archive/sherpa-sensevoice/`，不进部署。
- **前端 JS 与模型分离**：`native-asr.js`、`sensevoice-asr.js` 是**前端代码**，放 `js/` 目录、走 Pages 静态；**只有模型二进制**（`model.int8.onnx`、`tokens.txt`、`meta.json`、`ort/*`）走 R2。`/sensevoice/*` 被 Pages Function 拦截从 R2 读取，而 `/js/*` 由 Pages 静态目录正常提供（**不要把前端 JS 放 `/sensevoice/`，会被 Function 误拦截导致 500**）。

### 部署步骤（概要）

1. **Pages**：仓库连 Cloudflare Pages（纯静态 + Functions，无需构建），自定义域名。前端 JS 在 `js/`（git 管，走静态）。
2. **R2**：建 bucket **`wewalkworld-models`** → 传 `sensevoice/` 下：`model.int8.onnx`、`tokens.txt`、`meta.json`、`ort/*`（6 个运行时文件）。桶内对象 key 带 `sensevoice/` 前缀（Function 也兼容平铺）。
3. **Pages 绑定 R2**：在 Cloudflare 控制台 → Pages 项目 → Settings → Bindings → 添加 **R2**，变量名 `MODELS`，选 bucket `wewalkworld-models`。
4. （前端脚本已走 `/js/`，模型请求 `/sensevoice/...` 由 Function 代理回源，支持 Range 断点续传 + long 缓存）

> `functions/sensevoice/[[path]].js` 已包含：R2 key 前缀/平铺兜底、Range(206 分片)、CORS、`Cache-Control: public,max-age=31536000,immutable`。

### 首次加载（~240MB）的用户体验

- 页面秒开（代码在 Pages）→ 显示"正在下载模型 x%"，fetch 用 `ReadableStream` 实时进度。
- 支持断点续传（R2 Range + 分片），"仅 Wi-Fi 下载"开关，明确提示建议 Wi-Fi。
- 只在进入语音功能时才触发下载（懒加载），不用语音的用户零成本。

### 手机设备要求

| 平台 | 可行性 | 注意 |
|---|---|---|
| 桌面 Chrome/Edge | ✅ 最佳 | 内存充足 |
| Android Chrome | ✅ 可行 | 内存 ~2GB+；建议 Wi-Fi 下载 |
| iPhone Safari | ⚠️ 紧张但可行 | tab 内存 ~1.5GB 上限，228MB 模型"刚好"；单线程 wasm、及时释放 |

### 模型缓存逻辑

- 模型内容寻址（文件名带版本号）→ 缓存可长期 immutable，升级改 URL。
- 浏览器 HTTP 缓存 + Service Worker 预缓存 + IndexedDB 分片（断点续传）。
- 模型不变：`Cache-Control: max-age=31536000, immutable`。

### 注意事项

- **>25MB 文件一律走 R2**（`ort-wasm-simd-threaded.jsep.wasm` 25MB 很悬）。
- 首次下载必须有进度条/重试，否则像卡死。
- iOS 站点存储配额可能只有几百 MB → 用 IndexedDB 分片，或提供"下载到本机文件系统"。
- 隐私：**本地 SenseVoice 路径**推理在设备、**音频不离开设备**；**原生 Web Speech API 路径**会把音频上传云端（Google / Azure / Apple）——隐私敏感场景走本地路径（原生断网即自动回退本地）。

---

## 文档索引

| 编号 | 主题 |
|---|---|
| `000` | 预设用语上传/共享方案（讨论） |
| `001` | 当前实现总结 |
| `003` | 浏览器语音识别：尝试记录 · 踩坑 |
| `004` | 浏览器语音识别：技术实现 |
| `005` | 开源文档 |
| `006` | 部署文档（CF Pages/R2/移动端/缓存） |
| `007` | 方法论（浏览器跑大模型的经验） |
| `017` | 浏览器版 SenseVoice 实现方案（初稿） |
| `018` | 调研：三大浏览器（Safari/Edge/Chrome）原生语音识别 API |
| `019` | 方案：接入云端语音识别 API（第三条腿）与真人测试 |
| `020` | 需求：消息增强（复制/缩播放键/收藏）、引用、粘贴、图片相册 |

## 许可与第三方资源

- 本仓库代码：MIT（待定，见 `005`）
- SenseVoice 模型：Apache-2.0（FunAudioLLM）；onnxruntime-web：MIT；sherpa-onnx：Apache-2.0；Silero VAD：MIT
