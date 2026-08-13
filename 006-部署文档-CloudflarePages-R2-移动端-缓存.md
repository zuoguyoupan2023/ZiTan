# 006 · 部署文档 —— Cloudflare Pages/Worker + R2 存储桶 + 移动端 + 缓存

> 日期：2026-08-12　·　状态：**部署方案（未执行）**
> 定位：讲清"网页放哪、大模型放哪、用户首次加载怎么下载、手机能不能跑、缓存怎么做、有哪些注意事项"。
> 关联：`004`（技术）、`README.md`（部署总览）、`003`（资源来源）。

---

## 〇、部署架构总览

```
┌─────────────────────────────────────────────────┐
│ 用户浏览器（桌面/手机）                           │
│   打开 https://zitan.wewalk.world                │
└───────────────┬─────────────────────────────────┘
                │ HTTPS
        ┌───────┴────────┐        ┌──────────────────────┐
        │ Cloudflare     │  fetch │  Cloudflare R2        │
        │ Pages / Worker │ ─────▶ │  models bucket（大资产）│
        │ （HTML/JS/CSS）  │        │  model.int8.onnx 228MB│
        │  小文件可直放    │        │  ort/*.wasm          │
        └────────────────┘        └──────────────────────┘
                静态站点(页代码)       对象存储(模型/引擎，>25MB)
```

**为什么拆两份**：Cloudflare Pages 对单文件有 **~25MB 上限**（默认上传限制），228MB 的模型、11~25MB 的 wasm 引擎都放不下。**R2 对象存储没有这个限制**，且支持 HTTP Range 断点续传 → 大资产全部放 R2，网页只放代码。

## 一、各资产放哪

| 资产 | 大小 | 放哪 | 说明 |
|---|---|---|---|
| `index.html`、各测试页、sw.js、manifest | <1MB | **Pages** | 直接部署 |
| `sensevoice/meta.json`、tokens.txt | <1MB | **Pages 或 R2** | 小，可放 Pages |
| `sensevoice/ort/ort.min.js` + `ort-wasm-simd-threaded.wasm` | 12MB | **R2**（或 Pages，<25MB） | 12MB 单文件可放 Pages；`jsep.wasm`(25MB) 与更保险的放 R2 |
| `sensevoice/model.int8.onnx` | 228MB | **R2** | 核心大资产，必须 R2 |
| `sensevoice/sherpa-onnx-wasm-main-vad-asr.data` | 231MB | **R2（仅 sherpa 路线需要）** | 用推荐路线 B（ORT）则**不需要**，省 231MB |
| `sensevoice/sherpa-onnx-wasm-main-vad-asr.js/.wasm` | 11MB | **R2（仅 sherpa 路线）** | — |

> **推荐只部署路线 B（onnxruntime-web）**：首载 ≈ 228MB（模型）+ 12MB（ort wasm）≈ **240MB**，而非 500MB。sherpa 路线的 `.data`（231MB）在 ORT 路线下完全用不上，可不上传。

## 二、首次加载：用户点开网页 → 下载 ~240MB 怎么做

1. **加载流程**：
   - 网页先秒开（代码在 Pages，<1MB）。
   - 页面显示"正在下载模型 0→100%"（fetch 带 `ReadableStream`，每拿到一块更新进度条）。
   - 下载完 → onnxruntime-web 初始化 session → 显示"模型就绪"。
2. **断点续传/可恢复**：R2 支持 HTTP Range。断网重连后可从上次位置续下（前端需自行实现分片下载 + IndexedDB 暂存，或用浏览器缓存天然断点）。
3. **下载体验建议**：
   - 进度条 + 当前 MB/总 MB + 预估网速。
   - "仅 Wi-Fi 下载"开关（`navigator.connection.effectiveType`）。
   - 首次提示"约 240MB，建议 Wi-Fi"。
4. **懒加载/按需**：只在用户真正要用语音识别时才拉模型，进语音页再触发下载；不想用的用户不花流量。

## 三、模型缓存逻辑

| 层 | 机制 | 说明 |
|---|---|---|
| **浏览器 HTTP 缓存** | R2 对象设 `Cache-Control: public, max-age=31536000, immutable` | 模型不变，可缓存一年；命中后秒开 |
| **Service Worker** | 现有 `sw.js` 扩展：把模型/ort 加进预缓存 | 离线可用；注意 240MB 的 Cache API 配额（见 §五） |
| **IndexedDB** | 分片存模型字节 | 比 Cache API 配额更稳、可控；适合断点续传 |
| **R2 侧** | 对象设 Cache-Control；或经 Worker 用 Cache API 二次缓存 | 减少边缘回源 |

> 关键：模型**内容寻址**（文件名带版本，如 `model.int8.v2.onnx`），升级模型时改 URL，让旧缓存自然失效。

## 四、手机设备要求

| 平台 | 内存 | 可行性 | 注意 |
|---|---|---|---|
| **桌面 Chrome/Edge** | 无压力 | ✅ 最佳 | 内存充足、加载快 |
| **Android Chrome** | ~2GB+ 上限 | ✅ 可行 | 首次下载大；建议仅 Wi-Fi |
| **iPhone Safari** | tab 内存 ~1.5GB 上限 | ⚠️ 可行但最紧 | 228MB 模型 + WASM 运行时"刚好但紧张"；建议：单线程 wasm、及时释放、不复用多份模型拷贝 |

**注意事项（移动端）**：
- **内存**：onnxruntime-web 加载 228MB 模型 + 推理中间结果，iPhone 上要测。若 OOM → 降级方案（换更小模型、或提示用桌面版）。
- **单线程**：默认 `numThreads=1`，避免 COOP/COEP 跨域隔离要求（跨域隔离 iOS 支持不稳定）。
- **音频**：iOS Safari 需要用户手势后才能 `getUserMedia`（按钮点击触发，已在页面实现）。
- **后台/锁屏**：识别过程中锁屏会停录音，需提示用户保持前台。
- **省电**：WASM 推理耗 CPU，长时间录音注意发热。

## 五、部署到 Cloudflare 的具体步骤

### 5.1 网页（Pages）
1. 把 git 仓库连到 Cloudflare Pages（或直接拖文件夹上传）。
2. 无需构建（纯静态）。`_headers` 保留：`/index.html` no-cache，其余静态资源可短缓存。
3. 自定义域名（已有 wewalk.world）。

### 5.2 大模型（R2）
1. 建 bucket（如 `zitan-models`）。
2. 上传 `model.int8.onnx`、`tokens.txt`、`sensevoice/ort/`。
3. 开 **Public Access**（或绑自定义域名，如 `models.zitan.wewalk.world`）。
4. 给对象设 `Cache-Control: public, max-age=31536000, immutable`（经 wrangler/控制台/API）。
5. **CORS**：网页在 `zitan.wewalk.world`，模型在 `models.zitan.wewalk.world` → R2 bucket 需配 CORS（允许 `https://zitan.wewalk.world`，方法 GET，头 Range）。

### 5.3 （可选）Worker 中转
想统一域名/加缓存/限流时，用 Worker 代理 R2：
```js
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const key = url.pathname.slice(1);        // /model.int8.onnx
    const obj = await env.MODELS.get(key);     // R2 binding
    if (!obj) return new Response('not found', { status: 404 });
    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('Cache-Control', 'public, max-age=31536000, immutable');
    headers.set('Access-Control-Allow-Origin', 'https://zitan.wewalk.world');
    headers.set('Accept-Ranges', 'bytes');
    return new Response(obj.body, { headers });
  }
}
```
> R2 绑定 + Worker 还能做：`Cache API` 二次缓存（热门对象 0 回源）、按用户限流、统计下载。

### 5.4 前端接 R2
页面里模型地址不写死：用一个 `config.js` 或构建期替换 `window.APP_MODEL_URL` / `ort.env.wasm.wasmPaths` 指到 R2 域名。

## 六、注意事项汇总

- **25MB 限制**：Pages 单文件上限 ~25MB；`ort-wasm-simd-threaded.jsep.wasm`（25MB）很悬，**所有二进制走 R2 最稳**。
- **首次 240MB 的耐心**：没有进度条/断点续传，用户会以为卡死 → 必须有进度 + 可重试。
- **配额**：iOS Safari 站点存储（Cache API/IndexedDB）可能只有几百 MB，240MB 模型紧张 → 用 IndexedDB 分片 + 提示"下载到本机文件系统"（File System Access API，桌面可用）。
- **隐私**：模型从 R2 拉、推理在本地 → 音频依然不离开设备，README 里写清楚。
- **升级模型**：改文件名/加版本号，避免旧缓存。
- **成本**：R2 免费额度 10GB 存储、约 100 万次读请求/月；240MB × 用户数，请求次数注意。可加 Worker 缓存热门对象压回源。

## 七、部署自检清单

- [ ] Pages 只有代码，无 >25MB 文件
- [ ] R2 bucket：公共读 + CORS + immutable 缓存头 + 自定义域名（可选）
- [ ] 前端模型 URL 指向 R2，且带进度条/断点续传
- [ ] iPhone 真机实测识别（内存）
- [ ] 离线模式（飞行模式重开）模型从缓存秒开
- [ ] 隐私说明更新（模型来源、音频不出设备）
