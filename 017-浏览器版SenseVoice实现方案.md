# 017 · 浏览器版 SenseVoice（239M int8）实现方案 + PWA 建议

> 状态：**调研 + 方案（2026-08-12）**；定位：用已下载的 **239M `model.int8.onnx`（SenseVoice-Small）**实现"纯浏览器语音识别"，给出 **单 HTML / Vue / React** 三版方案；说明官方量化版本情况；最后给 **PWA（添加到桌面、离线用）** 建议。
> 关联：`016`（手机 App ASR 调研，本文的模型来源）、`007`（§3.7 浏览器 ONNX 踩坑史）、`010`（本地语音一体化）、`015`（Tabu-Local）。

---

## 〇、事实澄清（先纠正 016 里的一处误传）

| 数字 | 真实含义 | 实测/来源 |
|---|---|---|
| **~239MB** | **`model.int8.onnx` 的真实文件大小** = **239,233,841 字节**（HTTP HEAD 实测） | `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` |
| **~228M** | 007 文档里记录本地部署的大小——与 239MB 是**同一物**（完整 int8），只是快照/导出版本略有差异 | 007 §3.8.3b |
| **~76MB** | **系博客误传**，实测不存在（`DennisHuang648/SenseVoiceSmall-onnx` 里根本没有 `model.int8.onnx`，返回 404） | 本文已用 HEAD 请求证伪 |
| **234M** | **参数量**（不是文件大小）：SANM 编码器 + 单 CTC 头，非自回归 | 模型架构 |

> **结论**：你手里的 239MB 就是 sherpa-onnx 官方完整 int8 量化版，**没有更小的官方 ONNX**。**"int8 量化版"问题在下一节直接回答：这个 239MB 本身就是官方量化版**；更小的只有 GGUF（Q4/Q5/Q6，见 §七），但**不跑浏览器**。

---

## 一、浏览器可行性结论（先说结论）

- ✅ **可行**，且官方维护了现成方案：**sherpa-onnx 的 WebAssembly 构建 + `wasm/vad-asr` 官方演示**，原生支持 SenseVoice（非流式识别 + Silero VAD + 麦克风），就是为浏览器设计的。
- **性能**：SenseVoice 极快（~10s 音频 ≈70ms 推理，比 Whisper-Large 快 ~15×）；WASM 端到端识别延迟 100-500ms，够用。
- **内存/体积**：239MB 模型 + wasm 运行时（初始 512MB 堆、可增长）。**桌面无压力；手机可用但紧张**（尤其 iOS WebKit ~1.5GB tab 内存上限）。
- **transformers.js 不行**：2026 官方仍**不支持 SenseVoice** 架构（只有 Whisper/Wav2Vec2/AST 等）——与 007 §3.7.1 的结论一致。
- **onnxruntime-web 裸推理可行但要自己写全套 DSP**（mel 预处理 + token 解码 + 情感标签后处理），工程量大，**不推荐自建**（见 §三）。
- **推荐路线：sherpa-onnx WASM**（官方维护、VAD/识别/内存管理一篮子），且与 Tabu-Local 桌面用的**同一批 ONNX 文件**（239M int8 + tokens.txt）可直接复用。

> ⚠️ 对照 007 的历史：当年放弃浏览器 ONNX 主要栽在 **Whisper 量化解码器**（onnxruntime-web 的 `Missing required scale`）和 **transformers.js 不支持 SenseVoice**；而 **sherpa-onnx WASM 的 SenseVoice 当时是"未验证"，不是"验证失败"**。2026 官方演示页（HF Spaces / ModelScope）已把这条路跑通。

---

## 二、方案 A：单 HTML 文件（sherpa-onnx WASM，推荐）

### 2.1 需要的文件（从官方 GitHub releases / 演示页获取）

| 文件 | 作用 | 来源 |
|---|---|---|
| `sherpa-onnx-wasm-main-vad-asr.js` + `.wasm` | Emscripten 主模块（含 `OfflineRecognizer` / `createVad` / `CircularBuffer` 的 C++ 侧） | sherpa-onnx 仓库 `wasm/vad-asr/`，或用 `build-wasm-simd-vad-asr.sh` 自编译 |
| `sherpa-onnx-asr.js` / `sherpa-onnx-vad.js` | JS 胶水：`OfflineRecognizer` / `createVad` / `CircularBuffer` | 同上 |
| `*.data`（可选） | 把 `model.int8.onnx` + `tokens.txt` 打进 Emscripten 虚拟文件系统，加载即用 | 用官方 `pack.py` 打包（HF 演示仓库有现成脚本） |
| `model.int8.onnx`（239MB）+ `tokens.txt` | **SenseVoice-Small 完整 int8** + 词表（含情感/事件标签 token） | `csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17` |

**两种模型加载姿势**：
- **A1（推荐，内存省）**：模型打进 `.data`，随模块初始化**流式写入 wasm 堆**，进度由 `Module.setStatus` 上报（官方 demo 即此）。缺点：要先跑一次打包脚本生成 `.data`。
- **A2（免打包，开发快）**：`fetch` 模型 + tokens → `Module.FS.writeFile('/sense-voice.onnx', bytes)`。缺点：JS 侧 `ArrayBuffer` + wasm 堆**双份 239MB**，桌面没事，手机更紧张。

### 2.2 完整单页 `index.html`（基于官方 `wasm/vad-asr` 精简）

> 脚本**加载顺序**必须与官方一致：先 `sherpa-onnx-asr.js`、再 `sherpa-onnx-vad.js`、再你自己的代码、最后 `sherpa-onnx-wasm-main-vad-asr.js`（最后这个触发模型下载 + 初始化）。

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SenseVoice 浏览器离线识别</title>
</head>
<body>
  <h1>SenseVoice 离线语音识别（sherpa-onnx WASM）</h1>
  <p id="status" style="color:#999">加载中…</p>
  <button id="startBtn" disabled>开始录音</button>
  <button id="stopBtn" disabled>停止</button>
  <button id="clearBtn">清空</button>
  <pre id="results" style="white-space:pre-wrap;min-height:120px;border:1px solid #ccc"></pre>

  <!-- ① ASR 胶水（定义 OfflineRecognizer） -->
  <script src="sherpa-onnx-asr.js"></script>
  <!-- ② VAD 胶水（定义 createVad / CircularBuffer） -->
  <script src="sherpa-onnx-vad.js"></script>

  <script>
  // ========== ③ 你自己的应用代码 ==========
  const statusEl = document.getElementById('status');
  const resultsEl = document.getElementById('results');
  const startBtn = document.getElementById('startBtn');
  const stopBtn  = document.getElementById('stopBtn');
  const clearBtn = document.getElementById('clearBtn');

  let vad = null, buffer = null, recognizer = null;
  let audioCtx, mediaStream, recorder;
  const EXPECTED_SR = 16000;

  // --- Emscripten Module 钩子（在 sherpa-onnx-wasm-main-*.js 之前定义）---
  window.Module = {};
  Module.locateFile = (path, scriptDir = '') => scriptDir + path;
  Module.setStatus = (s) => { statusEl.textContent = s; };   // 含模型下载进度
  Module.onRuntimeInitialized = () => {
    // 模型已进虚拟文件系统（.data 或 FS.writeFile）
    vad      = createVad(Module);
    buffer   = new CircularBuffer(30 * EXPECTED_SR, Module);   // 30s 环形缓冲
    recognizer = new OfflineRecognizer({                        // ★ SenseVoice 配置
      modelConfig: {
        debug: 0,
        tokens: './tokens.txt',
        senseVoice: { model: './sense-voice.onnx', useInverseTextNormalization: 1 },
      },
    }, Module);
    startBtn.disabled = false;
    statusEl.textContent = '模型就绪，可开始录音';
  };

  // --- 麦克风：ScriptProcessor 采集 + 降采样到 16k ---
  navigator.mediaDevices.getUserMedia({ audio: true }).then((stream) => {
    audioCtx = new AudioContext({ sampleRate: EXPECTED_SR });
    mediaStream = audioCtx.createMediaStreamSource(stream);
    recorder = audioCtx.createScriptProcessor(4096, 1, 2);
    recorder.onaudioprocess = (e) => {
      const samples = downsampleBuffer(new Float32Array(e.inputBuffer.getChannelData(0)), EXPECTED_SR);
      buffer.push(samples);
      while (buffer.size() > vad.config.sileroVad.windowSize) {
        const s = buffer.get(buffer.head(), vad.config.sileroVad.windowSize);
        vad.acceptWaveform(s);
        buffer.pop(vad.config.sileroVad.windowSize);
        // 说话结束 → 取整段做离线识别
        while (!vad.isEmpty()) {
          const seg = vad.front(); vad.pop();
          const stream = recognizer.createStream();
          stream.acceptWaveform(EXPECTED_SR, seg.samples);
          recognizer.decode(stream);
          const r = recognizer.getResult(stream);
          if (r.text) resultsEl.textContent += r.text + '\n';
          stream.free();
        }
      }
    };
  }).catch((e) => alert('麦克风授权失败：' + e));

  startBtn.onclick = () => { mediaStream.connect(recorder); recorder.connect(audioCtx.destination); startBtn.disabled = true; stopBtn.disabled = false; };
  stopBtn.onclick  = () => { recorder.disconnect(audioCtx.destination); mediaStream.disconnect(recorder); vad.reset(); buffer.reset(); startBtn.disabled = false; stopBtn.disabled = true; };
  clearBtn.onclick = () => { resultsEl.textContent = ''; };

  // --- 降采样（官方同款）---
  function downsampleBuffer(buf, outRate) {
    if (buf.length === 0) return buf;
    const src = audioCtx.sampleRate;
    if (src === outRate) return buf;
    const ratio = src / outRate, newLen = Math.round(buf.length / ratio);
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) out[i] = buf[Math.floor(i * ratio)];
    return out;
  }
  </script>

  <!-- ④ Emscripten 主模块（触发模型下载 + onRuntimeInitialized）→ 必须最后 -->
  <script src="sherpa-onnx-wasm-main-vad-asr.js"></script>
</body>
</html>
```

### 2.3 关键 API 说明（给后续 Vue/React 复用）

| API | 作用 | 备注 |
|---|---|---|
| `new OfflineRecognizer(config, Module)` | 非流式识别器（SenseVoice/Whisper/Moonshine/Paraformer 均可） | `config.modelConfig.senseVoice = { model, useInverseTextNormalization:1 }`；`tokens:'./tokens.txt'` |
| `recognizer.createStream()` → `stream.acceptWaveform(sr, Float32Array)` → `recognizer.decode(stream)` → `getResult(stream)` | 喂音频 → 解码 → 取结果 | `getResult` 返回 `{ text, lang, emotion, event, tokens, timestamps }`——**SenseVoice 特有的 `lang/emotion/event`**（情感/事件标签） |
| `createVad(Module)` | Silero VAD（语音端点检测） | `vad.acceptWaveform / isDetected / front / pop / isEmpty` |
| `new CircularBuffer(容量, Module)` | 音频环形缓冲 | `push / get / head / pop / size / reset` |
| `Module.setStatus` | 上报"下载/初始化"进度 | 官方用它展示模型下载百分比 |
| `Module.FS.writeFile(path, Uint8Array)` | 免打包把模型/tokens 写进 FS（方案 A2） | 双份内存，仅开发用 |

### 2.4 里程碑建议（先文件后麦克风）

1. **里程碑 1**：单页「上传音频文件 → 转写」（不碰麦克风/VAD，最简验证模型 + wasm 链路）。
2. **里程碑 2**：加上面麦克风 + VAD（实时分段识别）。
3. **里程碑 3**：接 PWA（§八）离线安装。

---

## 三、方案 B：onnxruntime-web 裸推理（不推荐自建）

- **能跑**：`onnxruntime-web`（`executionProviders:['webgpu','wasm']`）加载 239MB int8 ONNX 没问题（int8 是标准 QDQ 量化，WASM/WebGPU 均支持）。
- **但你要自写整条管道**：
  1. **mel/fbank 预处理**（SenseVoice 输入是 80 维 fbank，16k 音频 → 帧特征）；
  2. **ONNX 输入/输出张量**（`{feats, feats_length}` / 输出 CTC logits）；
  3. **token 解码 + 特殊标签**（25055 词表，含 `<|zh|>` `<|HAPPY|>` `<|BGM|>` 等语言/情感/事件标签，还要去 `ignore` token）；
  4. **VAD + 切段**（自己接 Silero-VAD）。
- **007 已实踩的坑**：onnxruntime-web 对量化解码器有 `Missing required scale` 缺陷（Whisper）；transformers.js 不支持 SenseVoice。**做 DSP 属于重复造轮子**。
- **结论**：除非你有明确理由（如想用 WebGPU 拿极致速度、不想引 sherpa 依赖），否则**直接用方案 A**。WebGPU 加速对 SenseVoice 这类快模型收益有限（WASM 已 100-500ms）。

---

## 四、方案 C：Vue 3 版本

> 思路：ASR 引擎不变（同一套 wasm），只是用 **composable 封装**，让组件干净。Vue/React 都不改变识别能力，只改变工程化组织方式。

### 4.1 `src/composables/useSenseVoice.js`

```js
import { ref, shallowRef, onMounted, onBeforeUnmount } from 'vue'

export function useSenseVoice() {
  const status = ref('加载中…')
  const text   = ref('')
  const ready  = ref(false)
  const recording = ref(false)
  const vad = shallowRef(null), buffer = shallowRef(null), recognizer = shallowRef(null)
  let audioCtx = null, mediaStream = null, recorder = null
  const SR = 16000

  function initRecognizer() {
    vad.value      = createVad(Module)
    buffer.value   = new CircularBuffer(30 * SR, Module)
    recognizer.value = new OfflineRecognizer({
      modelConfig: {
        debug: 0,
        tokens: './tokens.txt',
        senseVoice: { model: './sense-voice.onnx', useInverseTextNormalization: 1 },
      },
    }, Module)
    ready.value = true
    status.value = '模型就绪'
  }

  onMounted(() => {
    window.Module = {}
    Module.locateFile = (p, d = '') => d + p
    Module.setStatus = (s) => { status.value = s }
    Module.onRuntimeInitialized = initRecognizer
    // 在 index.html 里先 <script src="sherpa-onnx-wasm-main-vad-asr.js">，或这里动态注入
  })

  async function start() {
    if (!ready.value) return
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    audioCtx = new AudioContext({ sampleRate: SR })
    mediaStream = audioCtx.createMediaStreamSource(stream)
    recorder = audioCtx.createScriptProcessor(4096, 1, 2)
    recorder.onaudioprocess = onAudio
    mediaStream.connect(recorder); recorder.connect(audioCtx.destination)
    recording.value = true
  }
  function stop() {
    recorder?.disconnect(audioCtx.destination); mediaStream?.disconnect(recorder)
    vad.value?.reset(); buffer.value?.reset(); recording.value = false
  }
  function onAudio(e) {
    const samples = down(new Float32Array(e.inputBuffer.getChannelData(0)))
    buffer.value.push(samples)
    while (buffer.value.size() > vad.value.config.sileroVad.windowSize) {
      vad.value.acceptWaveform(buffer.value.get(buffer.value.head(), vad.value.config.sileroVad.windowSize))
      buffer.value.pop(vad.value.config.sileroVad.windowSize)
      while (!vad.value.isEmpty()) {
        const seg = vad.value.front(); vad.value.pop()
        const st = recognizer.value.createStream()
        st.acceptWaveform(SR, seg.samples); recognizer.value.decode(st)
        const r = recognizer.value.getResult(st)
        if (r.text) text.value += r.text + '\n'
        st.free()
      }
    }
  }
  const down = (buf) => { /* 见方案 A 的 downsampleBuffer */ return buf }
  onBeforeUnmount(stop)
  return { status, text, ready, recording, start, stop }
}
```

### 4.2 组件 `SenseVoicePanel.vue`

```vue
<template>
  <div>
    <p>{{ status }}</p>
    <button :disabled="!ready || recording" @click="start">开始录音</button>
    <button :disabled="!recording" @click="stop">停止</button>
    <pre>{{ text }}</pre>
  </div>
</template>
<script setup>
import { useSenseVoice } from '../composables/useSenseVoice'
const { status, text, ready, recording, start, stop } = useSenseVoice()
</script>
```

**打包注意**：`.wasm`/`.data`/`.onnx` 要作为静态资源（`public/`）原样提供，别让打包器处理；`Module.locateFile` 的 `scriptDirectory` 指向实际静态路径。

---

## 五、方案 D：React 版本

> 同样的封装思路，用 **hook**。

### 5.1 `src/hooks/useSenseVoice.js`

```js
import { useCallback, useEffect, useRef, useState } from 'react'

export function useSenseVoice() {
  const [status, setStatus] = useState('加载中…')
  const [text, setText] = useState('')
  const [ready, setReady] = useState(false)
  const [recording, setRecording] = useState(false)
  const vadRef = useRef(null), bufRef = useRef(null), recRef = useRef(null)
  const SR = 16000

  useEffect(() => {
    window.Module = {}
    Module.locateFile = (p, d = '') => d + p
    Module.setStatus = setStatus
    Module.onRuntimeInitialized = () => {
      vadRef.current = createVad(Module)
      bufRef.current = new CircularBuffer(30 * SR, Module)
      recRef.current = new OfflineRecognizer({
        modelConfig: { debug: 0, tokens: './tokens.txt',
          senseVoice: { model: './sense-voice.onnx', useInverseTextNormalization: 1 } },
      }, Module)
      setReady(true); setStatus('模型就绪')
    }
  }, [])

  const start = useCallback(async () => {
    if (!ready) return
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const audioCtx = new AudioContext({ sampleRate: SR })
    const src = audioCtx.createMediaStreamSource(stream)
    const rec = audioCtx.createScriptProcessor(4096, 1, 2)
    rec.onaudioprocess = (e) => {
      const samples = new Float32Array(e.inputBuffer.getChannelData(0))
      bufRef.current.push(samples)
      while (bufRef.current.size() > vadRef.current.config.sileroVad.windowSize) {
        vadRef.current.acceptWaveform(bufRef.current.get(bufRef.current.head(), vadRef.current.config.sileroVad.windowSize))
        bufRef.current.pop(vadRef.current.config.sileroVad.windowSize)
        while (!vadRef.current.isEmpty()) {
          const seg = vadRef.current.front(); vadRef.current.pop()
          const st = recRef.current.createStream()
          st.acceptWaveform(SR, seg.samples); recRef.current.decode(st)
          const r = recRef.current.getResult(st)
          if (r.text) setText((t) => t + r.text + '\n')
          st.free()
        }
      }
    }
    src.connect(rec); rec.connect(audioCtx.destination)
    setRecording(true)
  }, [ready])

  const stop = useCallback(() => {
    setRecording(false)
    vadRef.current?.reset(); bufRef.current?.reset()
  }, [])

  return { status, text, ready, recording, start, stop }
}
```

### 5.2 组件

```jsx
import { useSenseVoice } from './hooks/useSenseVoice'
export default function SenseVoicePanel() {
  const { status, text, ready, recording, start, stop } = useSenseVoice()
  return (
    <div>
      <p>{status}</p>
      <button disabled={!ready || recording} onClick={start}>开始录音</button>
      <button disabled={!recording} onClick={stop}>停止</button>
      <pre>{text}</pre>
    </div>
  )
}
```

> 注：社区 `@siteed/sherpa-onnx.rn` 是 **React Native（移动端）**，web 端没有官方 React/Vue wrapper——**自己包一层 hook/composable 即可**，别引 RN 包。

---

## 六、HTML vs Vue vs React 对比与选型

| 维度 | 单 HTML（方案 A） | Vue 3（方案 C） | React（方案 D） |
|---|---|---|---|
| **上手成本** | 零依赖，双击即跑 | 需 Vite 脚手架 | 需 CRA/Vite 脚手架 |
| **代码量** | 一个文件全含 | composable + 组件 | hook + 组件 |
| **维护性** | 低（脚本式） | 高（响应式状态） | 高 |
| **复用** | 差（复制粘贴） | 好（`useSenseVoice` 到处用） | 好（hook 到处用） |
| **体积** | 最小（无框架） | + ~40-60KB（Vue runtime） | + ~50-70KB（React） |
| **适用** | **原型验证 / 工具页 / 教具** | 已有 Vue 生态时 | 已有 React 生态时 |
| **ASR 能力** | 完全一致（同一 wasm） | 完全一致 | 完全一致 |

**建议**：
- **先做方案 A 单 HTML** 验证"239MB 模型 + 浏览器"这条路通不通（半小时工作量）。
- 通了之后，**若做正式功能并入现有产品**：看项目栈——Tabu-AI 是原生 JS 扩展（无框架），**接单 HTML / 原生 JS 最贴**；若有独立 Vue/React App 则封装成 composable/hook。
- **ASR 引擎与框架无关**，三版共用同一套 wasm 资产，迁移只换壳不换核。

---

## 七、官方量化版本情况（有没有更小的）

| 版本 | 大小 | 能否浏览器跑 | 说明 |
|---|---|---|---|
| **int8 ONNX（你手里这个）** | **239MB** | ✅ | **这就是官方量化版**，无更小的官方 ONNX |
| fp32 ONNX | ~900MB | ✅（太肥） | 官方有，没必要 |
| **GGUF Q8_0** | ~235-242MB | ❌ | sensevoice.cpp（ggml），CPU/Metal/CUDA，无 wasm 版 |
| **GGUF Q6_K** | ~187MB | ❌ | 同上 |
| **GGUF Q5_K_M** | ~164MB | ❌ | 同上 |
| **GGUF Q4_K_M / Q4_K** | ~139 / ~129MB | ❌ | 同上；cstr 称 Q4_K 为"推荐默认"，WER 仅略升（3.45% vs Q8 3.13%） |
| 4-bit ONNX 重量化 | 理论 ~60-120MB | 可能 | **非官方**，需自测；SenseVoice 有特殊 token/图结构，重量化后精度待验 |

**结论**：
1. **浏览器侧没有更小的官方版本**——239MB int8 就是最优官方选择。
2. 想更小（≤160MB）：只有 GGUF（Q5/Q4），但走 sensevoice.cpp，**不是浏览器**（可用在桌面/移动原生 App）。
3. 若嫌 239MB 太大又是纯浏览器场景：**换 Paraformer-zh int8（~226MB）**也没小多少；或接受"首次联网下载、之后离线缓存"（PWA 天然适合）。**真正的"小"选项是放弃大模型**——但中文+多语言+情感标签就只有 SenseVoice 类模型。
4. （可选研究）用 ORT 工具把 239MB 重量化为 **4-bit ONNX**（`onnxruntime.quantization` 的 `WeightOnlyQuantType` / 社区脚本），实测精度与速度后再决定。**未验证，慎用**。

---

## 八、PWA 建议（添加到桌面 · 离线使用）

### 8.1 为什么 PWA 适合这个场景
239MB 模型 + wasm 都是**静态资源** → Service Worker 一次缓存，之后**完全离线识别**。PWA = "打包成网页的本地 App"：桌面 Chrome/Edge「安装」成独立窗口，手机添加到主屏幕。

### 8.2 离线架构

```
[首次联网]  App Shell(html/js/css) + wasm(.js/.wasm/.data) + model(239MB) + tokens.txt
              ↓ 全部写进 Cache API（Service Worker install）
[之后离线]   打开 PWA → SW 从缓存提供一切 → 麦克风 → VAD → wasm 推理 → 文本
```

- **Service Worker `install` 时 pre-cache 全部资源**（含 239MB `.data`）。Emscripten 的 `.data` 加载走网络请求 → 被 SW 拦截 → 从缓存返回 → 离线可初始化。
- **下载体验**：239MB 首次下载必须给进度条。方案 A 的 `Module.setStatus` 已有"Downloading data x/y"；PWA 再加"仅 Wi-Fi 下载"开关 + 断点续传（用 Cache API 分片缓存或 `ReadableStream` 写入）。
- **`beforeinstallprompt`**：桌面 Chrome/Edge 弹"安装应用"；iOS Safari 需用户手动"添加到主屏幕"（无自动弹窗）。
- **manifest**：`display: standalone`、图标、`start_url`。
- **麦克风**：PWA（普通网页）可直接 `getUserMedia` 弹授权——**没有 MV3 扩展侧边栏那种授权坑**（007 §3.6.6 的问题在此不存在）。

### 8.3 平台注意事项

| 平台 | 表现 | 注意 |
|---|---|---|
| **桌面 Chrome/Edge** | ✅ 最佳：独立窗口、内存充足、加载快 | WebGPU 可用；WASM 已够快，可不强求 |
| **桌面 macOS Safari** | ✅ 可"添加到程序坞" | 兼容 wasm，无 WebGPU |
| **Android Chrome** | ✅ 真 PWA，添加到主屏幕后离线 OK | 内存 ~2GB 内可跑 |
| **iOS Safari** | ⚠️ 可行但最紧 | 无 WebGPU（走 WASM）；tab 内存 ~1.5GB 上限——239MB 模型 + 运行时**刚好但紧张**；首次下载大；麦克风授权一次；建议 `audioCtx` 复用、及时 `stream.free()` 释放 |

### 8.4 落地步骤（PWA 清单）

1. 方案 A 的 `index.html` 通过 → 加 `manifest.json` + `sw.js`。
2. `sw.js`：`install` 里 pre-cache 全部资源（含 239MB）；`activate` 清旧缓存；`fetch` 优先 cache。
3. 首次进入：显示"正在下载模型 (0/239MB)"+ 仅 Wi-Fi 开关（`navigator.connection` 探测）。
4. 桌面「安装应用」/ iOS「添加到主屏幕」。
5. 离线验证：飞行模式下打开 → 模型从缓存加载 → 说话识别。

> ⚠️ 存储注意：**Cache API / IndexedDB 的 239MB 在 iOS 上可能受限**（iOS 站点存储配额随系统/设备变，老系统可能只给几百 MB）。若线上存储紧张，模型可改存 **IndexedDB** 或提示用户"下载模型到本地文件系统"（`File System Access API`，Chrome/Edge 桌面可写文件）。**桌面 Chrome/Edge 是 PWA 的首选目标平台**。

---

## 参考链接

- sherpa-onnx 官方 wasm 演示源码：`wasm/vad-asr/app-vad-asr.js` · `index.html` · `sherpa-onnx-wasm-main-vad-asr.cc`（[k2-fsa/sherpa-onnx 仓库](https://github.com/k2-fsa/sherpa-onnx)）
- sherpa-onnx SenseVoice 预训练模型（239M int8 来源）：[csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17](https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17) · [SenseVoice 文档](https://raw.githubusercontent.com/k2-fsa/sherpa/master/docs/source/onnx/sense-voice/index.rst)
- sherpa-onnx JS API（OfflineRecognizer/getResult 含 lang/emotion/event）：[api_non_streaming_asr.rst](https://github.com/k2-fsa/sherpa/blob/master/docs/source/onnx/javascript-api/examples/api_non_streaming_asr.rst) · [DeepWiki WebAssembly](https://deepwiki.com/k2-fsa/sherpa-onnx/4.1-c-api-reference)
- sherpa-onnx wasm 打包工具 pack.py：[jiangzhuo9357/sherpa-onnx-asr-demos（HF Space）](https://huggingface.co/spaces/jiangzhuo9357/sherpa-onnx-asr-demos)
- GGUF 量化版（q4/q5/q6/q8，sensevoice.cpp）：[FunAudioLLM/SenseVoiceSmall-GGUF](https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF) · [cstr/sensevoice-small-GGUF](https://huggingface.co/cstr/sensevoice-small-GGUF) · [sensevoice.cpp](https://github.com/lovemefan/SenseVoice.cpp)
- 社区 wasm 封装（供参考）：[`@sherpaw/vad-asr`](https://socket.dev/npm/package/@sherpaw/vad-asr) · [`@siteed/sherpa-onnx.rn`（RN）](https://www.npmjs.com/package/@siteed/sherpa-onnx.rn) · [SenseVoice 浏览器 SDK @omote/core](https://www.npmjs.com/package/@omote/core)
- PWA 参考：MDN PWA（Service Worker / manifest / 离线）· iOS Safari 存储与 WebKit 限制
