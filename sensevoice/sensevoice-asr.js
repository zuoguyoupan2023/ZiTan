/* sensevoice-asr.js — 浏览器离线语音识别模块（onnxruntime-web + SenseVoice）
 * 用法：
 *   <script src="/sensevoice/sensevoice-asr.js"></script>
 *   await SenseVoiceAsr.ensureLoaded(progressCb)   // 首次懒加载模型（可选，start 时自动）
 *   SenseVoiceAsr.start(onResult, onStatus)        // 开始录音；说话停顿自动识别并停止
 *   SenseVoiceAsr.stop()                           // 手动停止
 *
 * 特性：
 *   - 懒加载：只有首次使用才拉 228MB 模型 + onnxruntime
 *   - 能量 VAD：静音/无语音不识别（避免模型对空白输出「그」等乱码）
 *   - 端点检测：说话停顿 ~0.7s 自动切句；单句最长 10s
 *   - 结果过滤：过短/纯噪音丢弃
 * 详见 004（技术）、003（踩坑）。
 */
(function (global) {
  'use strict';
  const SR = 16000;
  /* 资源根路径：默认同站 /sensevoice；部署时可用 window.ZITAN_ASR = { base: 'https://...' } 覆盖（模型放 R2） */
  const BASE = (global.ZITAN_ASR && global.ZITAN_ASR.base) || '/sensevoice';

  /* ---------- 运行时状态 ---------- */
  let session = null, meta = null, tokensTable = null;
  let loadingPromise = null;
  let loadingPct = null;

  /* ---------- 麦克风状态 ---------- */
  let audioCtx = null, mediaStream = null, processor = null;
  let running = false;
  let onResultCb = null, onStatusCb = null;
  let seg = [];                 // 当前语音段样本
  let state = 'idle';           // idle | silence | speech
  let silMs = 0;                // 静音累计时长(ms)
  let segMs = 0;                // 当前段时长(ms)
  const RMS_TH = 0.010;         // 语音/静音阈值（[-1,1] 幅度）
  const END_MS = 700;           // 说话结束静音判定
  const MAX_MS = 10000;         // 单句上限
  const MIN_MS = 250;           // 过短不识别（呼吸/点击声）

  /* ============ 懒加载 ============ */
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.onload = resolve; s.onerror = () => reject(new Error('加载失败 ' + src));
      document.head.appendChild(s);
    });
  }
  function ensureLoaded(progressCb) {
    if (session) return Promise.resolve();
    if (loadingPromise) return loadingPromise;
    loadingPromise = (async () => {
      if (typeof global.ort === 'undefined') {
        if (progressCb) progressCb('加载识别引擎…');
        await loadScript(BASE + '/ort/ort.min.js');
      }
      global.ort.env.wasm.wasmPaths = BASE + '/ort/';
      if (navigator.hardwareConcurrency > 1) global.ort.env.wasm.numThreads = 1;
      if (progressCb) progressCb('加载模型参数…');
      meta = await (await fetch(BASE + '/meta.json')).json();
      tokensTable = parseTokens(await (await fetch(BASE + '/tokens.txt')).text());
      if (progressCb) progressCb('加载语音模型（约 228MB）…');
      session = await global.ort.InferenceSession.create(BASE + '/model.int8.onnx',
        { executionProviders: ['wasm'] });
      return session;
    })().catch((e) => { loadingPromise = null; throw e; });
    return loadingPromise;
  }

  /* ============ DSP（与 004 验证一致的管线） ============ */
  const FS = 400, FSHIFT = 160, FFT = 512, NBINS = 80;
  const WIN = (() => { const w = new Float32Array(FS); for (let i = 0; i < FS; i++) w[i] = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (FS - 1)); return w; })();
  const hz2mel = h => 2595 * Math.log10(1 + h / 700), mel2hz = m => 700 * (Math.pow(10, m / 2595) - 1);
  const FILTERS = (() => {
    const fMin = 20, fMax = 8000, mMin = hz2mel(fMin), mMax = hz2mel(fMax);
    const nB = FFT / 2 + 1, filters = new Array(NBINS);
    const mp = [], bin = [];
    for (let i = 0; i < NBINS + 2; i++) { mp.push(mMin + (mMax - mMin) * i / (NBINS + 1)); bin.push(Math.floor((FFT + 1) * mel2hz(mp[i]) / SR)); }
    for (let i = 0; i < NBINS; i++) {
      const fb = new Float32Array(nB), s = bin[i], c = bin[i + 1], e = bin[i + 2];
      for (let j = s; j < c; j++) fb[j] = (j - s) / (c - s + 1e-6);
      for (let j = c; j < e; j++) fb[j] = (e - j) / (e - c + 1e-6);
      filters[i] = fb;
    }
    return filters;
  })();

  function fft(real, imag) {
    const n = real.length;
    for (let i = 1, j = 0; i < n; i++) { let b = n >> 1; for (; j & b; b >>= 1) j ^= b; j ^= b; if (i < j) { [real[i], real[j]] = [real[j], real[i]]; [imag[i], imag[j]] = [imag[j], imag[i]]; } }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len, wlR = Math.cos(ang), wlI = Math.sin(ang);
      for (let i = 0; i < n; i += len) { let wR = 1, wI = 0;
        for (let j = 0; j < len / 2; j++) {
          const uR = real[i + j], uI = imag[i + j], vR = real[i + j + len / 2] * wR - imag[i + j + len / 2] * wI, vI = real[i + j + len / 2] * wI + imag[i + j + len / 2] * wR;
          real[i + j] = uR + vR; imag[i + j] = uI + vI; real[i + j + len / 2] = uR - vR; imag[i + j + len / 2] = uI - vI;
          const nwR = wR * wlR - wI * wlI, nwI = wR * wlI + wI * wlR; wR = nwR; wI = nwI;
        } }
    }
  }
  function computeFbank(samples) {
    const nF = Math.floor((samples.length - FS) / FSHIFT) + 1;
    if (nF <= 0) return [];
    const real = new Float32Array(FFT), imag = new Float32Array(FFT), power = new Float32Array(FFT / 2 + 1);
    const feats = new Array(nF); let offset = 0;
    for (let f = 0; f < nF; f++) {
      real.fill(0); imag.fill(0);
      for (let i = 0; i < FS; i++) { const s = samples[offset + i] ?? 0, prev = i === 0 ? s : samples[offset + i - 1]; real[i] = (s - 0.97 * prev) * WIN[i]; }
      fft(real, imag);
      for (let i = 0; i < power.length; i++) power[i] = real[i] * real[i] + imag[i] * imag[i];
      const mel = new Float32Array(NBINS);
      for (let m = 0; m < NBINS; m++) { const fl = FILTERS[m]; let e = 0; for (let i = 0; i < fl.length; i++) e += fl[i] * power[i]; mel[m] = Math.log(Math.max(e, 1e-10)); }
      feats[f] = mel; offset += FSHIFT;
    }
    return feats;
  }
  function parseTokens(t) {
    const arr = []; let maxId = 0;
    const lines = t.split(/\r?\n/);
    for (const ln of lines) { const p = ln.trim().split(/\s+/); if (p.length >= 2 && /^\d+$/.test(p[1])) { const id = +p[1]; if (id > maxId) maxId = id; } }
    for (let i = 0; i <= maxId; i++) arr.push('');
    for (const ln of lines) { const p = ln.trim().split(/\s+/); if (p.length >= 2 && /^\d+$/.test(p[1])) arr[+p[1]] = p[0]; }
    return arr;
  }

  /* 识别一段 16k 样本 → 文本；静音由上层 VAD 把关 */
  async function recognizeSamples(samples) {
    if (!session) throw new Error('模型未加载');
    const normalize = !!meta.normalize_samples;
    const out = new Float32Array(samples.length); let sum = 0;
    for (let i = 0; i < samples.length; i++) { const v = normalize ? samples[i] : samples[i] * 32768; out[i] = v; sum += v; }
    const mean = sum / out.length; for (let i = 0; i < out.length; i++) out[i] -= mean;

    const feats = computeFbank(out);
    if (!feats.length) return '';
    const ws = meta.lfr_window_size, sh = meta.lfr_window_shift;
    const red = Math.floor((feats.length - ws) / sh) + 1;
    if (red <= 0) return '';
    // LFR 拼接 7 帧×80 维 → 560 维，再逐位置 CMVN（neg_mean/inv_stddev 是 560 维，按行内位置取）
    const D = 560, cmvn = new Float32Array(red * D);
    for (let i = 0; i < red; i++) {
      const row = i * D;
      for (let k = 0; k < ws; k++) {
        const fr = feats[i * sh + k];
        for (let j = 0; j < 80; j++) {
          const p = k * 80 + j;
          cmvn[row + p] = (fr[j] + meta.neg_mean[p]) * meta.inv_stddev[p];
        }
      }
    }
    const feeds = {
      x: new global.ort.Tensor('float32', cmvn, [1, red, D]),
      x_length: new global.ort.Tensor('int32', new Int32Array([red]), [1]),
      language: new global.ort.Tensor('int32', new Int32Array([meta.lang_auto]), [1]),
      text_norm: new global.ort.Tensor('int32', new Int32Array([meta.with_itn]), [1]),
    };
    const outputs = await session.run(feeds);
    const logits = outputs.logits || Object.values(outputs)[0];
    return ctcGreedy(logits);
  }
  function ctcGreedy(logits) {
    const T = logits.dims[1], VS = logits.dims[2], data = logits.data;
    const out = []; let prev = -1;
    for (let t = 0; t < T; t++) {
      let mi = 0, mv = -Infinity; const o = t * VS;
      for (let i = 0; i < VS; i++) { const v = data[o + i]; if (v > mv) { mv = v; mi = i; } }
      if (mi === 0 || mi === prev) { prev = mi; continue; }
      prev = mi;
      const tok = tokensTable[mi];
      if (tok && !tok.startsWith('<|')) out.push(tok);
    }
    return out.join('');
  }
  /* 结果过滤：去掉纯标点/单字乱码/语气词（如「그」「嗯」），保留正常文字 */
  const FILLERS = ['嗯', '唔', '呃', '啊', '哦', '恩', '哎', '哈'];
  function filterText(s) {
    s = s.trim();
    if (!s) return '';
    const core = s.replace(/[，。？！、；：,.!?;:]/g, '');
    if (!core) return '';
    if (core.length < 2 && !/[一-鿿]/.test(core)) return '';      // 单字且非中文 → 噪音（如「그」）
    if (core.length <= 2 && [...core].every(c => FILLERS.includes(c))) return ''; // 纯语气词 → 静音幻觉
    return s;
  }

  /* ============ 能量 VAD + 录音 ============ */
  function rms(arr) {
    let sum = 0; for (let i = 0; i < arr.length; i++) sum += arr[i] * arr[i];
    return Math.sqrt(sum / arr.length);
  }
  function onAudio(e) {
    if (!running) return;
    const raw = new Float32Array(e.inputBuffer.getChannelData(0));
    const samples = downsample(raw, audioCtx.sampleRate, SR);
    const frameMs = samples.length / SR * 1000;
    const r = rms(samples);
    const isSpeech = r > RMS_TH;

    if (state === 'idle') {
      if (isSpeech) { state = 'speech'; seg = Array.from(samples); segMs = frameMs; silMs = 0; }
      return;
    }
    if (state === 'speech') {
      seg.push.apply(seg, samples); segMs += frameMs;
      if (isSpeech) { silMs = 0; }
      else {
        silMs += frameMs;
        if (silMs >= END_MS || segMs >= MAX_MS) finalize();
      }
    }
  }
  function finalize() {
    if (state !== 'speech') return;
    state = 'idle';
    const samples = Float32Array.from(seg); seg = [];
    const ms = segMs; segMs = 0; silMs = 0;
    if (ms < MIN_MS) return;                       // 太短，忽略
    if (rms(samples) < RMS_TH * 0.8) return;       // 整段能量复查：近静音段不识别
    if (onStatusCb) onStatusCb('正在识别…');
    recognizeSamples(samples).then((text) => {
      text = filterText(text);
      stop();                                       // 一次说一句，识别完自动停
      if (onResultCb) onResultCb(text);
    }).catch((err) => { stop(); if (onResultCb) onResultCb(null); });
  }
  function downsample(buf, src, dst) { if (src === dst) return buf; const r = src / dst, n = Math.round(buf.length / r), o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = buf[Math.floor(i * r)]; return o; }

  function start(onResult, onStatus) {
    onResultCb = onResult; onStatusCb = onStatus || null;
    return (async () => {
      await ensureLoaded();
      mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const src = audioCtx.createMediaStreamSource(mediaStream);
      processor = audioCtx.createScriptProcessor(4096, 1, 2);
      processor.onaudioprocess = onAudio;
      src.connect(processor);
      processor.connect(audioCtx.destination);
      running = true; state = 'idle';
      if (onStatusCb) onStatusCb('请说话…');
    })();
  }
  function stop() {
    running = false; state = 'idle'; seg = [];
    try { if (processor) { processor.disconnect(); processor = null; } } catch (e) {}
    try { if (mediaStream) mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; } catch (e) {}
    try { if (audioCtx) { audioCtx.close(); audioCtx = null; } } catch (e) {}
  }

  /* 调试钩子：直接识别一段 16k 样本（供验证/测试用） */
  function debugRecognize(samples) { return recognizeSamples(samples); }

  /* 模型是否已加载就绪（供设置页展示“线下模型”状态） */
  function getReady() { return !!session; }

  global.SenseVoiceAsr = { ensureLoaded, start, stop, debugRecognize, getReady };
})(window);
