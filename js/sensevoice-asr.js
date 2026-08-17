/* sensevoice-asr.js — 浏览器离线语音识别模块（onnxruntime-web + SenseVoice）
 * 用法：
 *   <script src="/sensevoice/sensevoice-asr.js"></script>
 *   await SenseVoiceAsr.ensureLoaded(progressCb)   // 首次懒加载模型（可选，start 时自动）
 *   SenseVoiceAsr.start(onResult, onStatus)        // 开始录音；说话停顿自动识别并停止；onResult(text, recording)
 *   SenseVoiceAsr.recognizeBlob(blob)              // 解码已有音频并用模型识别
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
  let onResultCb = null, onStatusCb = null, onRecordingCb = null;
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
  /* —— 模型本地持久化：IndexedDB 分片存储 ——
   * 之前用 Cache API（zitan-asr）。iOS Safari（iPad）在未注册 Service Worker 时
   * Cache API 不落盘、刷新即丢 → 228MB 白白重下。IndexedDB 是标准持久化，且
   * 只归浏览器存储管理（SW 激活清理不到它），刷新/重启都还在。
   * 结构（库 zitan-asr，store kv，keyPath k）：
   *   'meta.json' / 'tokens.txt'            → 字符串整存
   *   'model.int8.onnx:meta'                → { totalBytes, chunkSize, chunkCount }
   *   'model.int8.onnx:0..N-1'              → 每片 ArrayBuffer（8MB，iOS 单条限制安全）
   * 完整性靠「meta 最后写入 + 读回时总长校验」：片缺/损坏 → 返回 null → 回归网络下载。 */
  const ASR_IDB = 'zitan-asr', ASR_IDB_STORE = 'kv';
  const MODEL_KEY = 'model.int8.onnx';
  const CHUNK_SIZE = 8 * 1024 * 1024;   /* 8MB/片 */
  function asrIdbOpen() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('no indexedDB'));
      const req = indexedDB.open(ASR_IDB, 1);
      req.onupgradeneeded = e => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains(ASR_IDB_STORE)) d.createObjectStore(ASR_IDB_STORE, { keyPath: 'k' });
      };
      req.onsuccess = e => resolve(e.target.result);
      req.onerror = e => reject(e.target.error || new Error('idb open fail'));
    });
  }
  function idbKvGet(k) {
    return asrIdbOpen().then(db => new Promise((resolve, reject) => {
      const rq = db.transaction(ASR_IDB_STORE, 'readonly').objectStore(ASR_IDB_STORE).get(k);
      rq.onsuccess = () => resolve(rq.result ? rq.result.v : null);
      rq.onerror = () => reject(rq.error);
    })).catch(() => null);
  }
  function idbKvSet(k, v) {
    return asrIdbOpen().then(db => new Promise((resolve, reject) => {
      const tx = db.transaction(ASR_IDB_STORE, 'readwrite');
      tx.objectStore(ASR_IDB_STORE).put({ k, v });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    })).catch(() => { /* 写失败（配额/IO）不致命：本次仍可用，下次重下 */ });
  }
  /* 删除所有以 prefix 开头的 key（重下前清旧片） */
  function idbKvDelPrefix(prefix) {
    return asrIdbOpen().then(db => new Promise((resolve) => {
      const tx = db.transaction(ASR_IDB_STORE, 'readwrite');
      const st = tx.objectStore(ASR_IDB_STORE);
      const rq = st.openCursor(IDBKeyRange.bound(prefix, prefix + '\uffff'));
      rq.onsuccess = () => {
        const cur = rq.result;
        if (cur) { st.delete(cur.key); cur.continue(); }
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    })).catch(() => {});
  }
  /* 读回模型全量字节；片缺/损坏/长度不符 → null（调用方回归网络下载） */
  async function modelLoad(onProgress) {
    try {
      const meta = await idbKvGet(MODEL_KEY + ':meta');
      if (!meta || !(meta.chunkCount > 0) || !(meta.totalBytes > 0)) return null;
      const n = meta.chunkCount, out = new Uint8Array(meta.totalBytes);
      let off = 0;
      for (let i = 0; i < n; i++) {
        const slice = await idbKvGet(MODEL_KEY + ':' + i);
        if (!(slice instanceof ArrayBuffer) && !ArrayBuffer.isView(slice)) return null;
        const bytes = new Uint8Array(slice);
        if (off + bytes.length > meta.totalBytes) return null;   /* 长度溢出 = 元数据不匹配 */
        out.set(bytes, off); off += bytes.length;
        if (onProgress) onProgress((i + 1) / n);
      }
      if (off !== meta.totalBytes) return null;   /* 总长校验 */
      return out;
    } catch (e) { return null; }
  }
  /* 分片写入：先清旧片，chunks 逐个写，最后写 meta（meta 在 = 写完整） */
  async function modelSave(buf) {
    const totalBytes = buf.length;
    const chunkCount = Math.ceil(totalBytes / CHUNK_SIZE);
    await idbKvDelPrefix(MODEL_KEY + ':');
    for (let i = 0; i < chunkCount; i++) {
      const slice = buf.subarray(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, totalBytes));
      await idbKvSet(MODEL_KEY + ':' + i, slice.slice().buffer);
    }
    await idbKvSet(MODEL_KEY + ':meta', { totalBytes, chunkSize: CHUNK_SIZE, chunkCount });
  }
  /* 供设置页：本地是否已存完整模型（轻查 meta，不读回 228MB） */
  async function hasStoredModel() {
    try { return !!(await idbKvGet(MODEL_KEY + ':meta')); } catch (e) { return false; }
  }

  /* 带进度地获取模型文件：IDB 命中直接读回（秒开），未命中网络下载并落盘。
   * 返回类型：'meta.json'/'tokens.txt' → 字符串；'model.int8.onnx' → Uint8Array。 */
  async function fetchCached(url, onProgress) {
    const name = url.slice(url.lastIndexOf('/') + 1);
    /* 小文件：字符串整存 */
    if (name === 'meta.json' || name === 'tokens.txt') {
      let t = await idbKvGet(name);
      if (t != null) { if (onProgress) onProgress(1); return t; }
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      t = await res.text();
      await idbKvSet(name, t);
      if (onProgress) onProgress(1);
      return t;
    }
    /* 大模型：IDB 分片 */
    if (name === MODEL_KEY) {
      const hit = await modelLoad(onProgress);
      if (hit) { if (onProgress) onProgress(1); return hit; }
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const total = parseInt(res.headers.get('Content-Length') || '0', 10) || 0;
      const reader = res.body.getReader();
      const chunks = []; let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); got += value.length;
        if (onProgress && total) onProgress(got / total);
      }
      const len = chunks.reduce((a, b) => a + b.length, 0);
      if (total && len !== total) throw new Error('下载不完整（' + len + '/' + total + '）');
      const buf = new Uint8Array(len);
      let off = 0;
      for (const cc of chunks) { buf.set(cc, off); off += cc.length; }
      await modelSave(buf).catch(() => {});   /* 落盘失败不影响本次使用 */
      if (onProgress) onProgress(1);
      return buf;
    }
    /* 其它（如 ort 的独立脚本由 loadScript 加载）：直接网络取 */
    const res = await fetch(url);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return new Uint8Array(await res.arrayBuffer());
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
      meta = JSON.parse(await fetchCached(BASE + '/meta.json'));
      tokensTable = parseTokens(await fetchCached(BASE + '/tokens.txt'));
      if (progressCb) progressCb('下载语音模型（约 228MB）…');
      // 带进度获取模型（IDB 命中秒开；未命中则下载并落盘），再交给 onnxruntime
      const modelBuf = await fetchCached(BASE + '/model.int8.onnx', (p) => {
        if (progressCb) progressCb(p);      // 数值进度 0..1
      });
      if (progressCb) progressCb(1);
      session = await global.ort.InferenceSession.create(modelBuf.buffer,
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
    const recording = { blob: encodeWav(samples, SR), type: 'audio/wav', ms: Math.round(ms) };
    if (onRecordingCb) onRecordingCb(recording);
    recognizeSamples(samples).then((text) => {
      text = filterText(text);
      stop();                                       // 一次说一句，识别完自动停
      if (onResultCb) onResultCb(text, recording);
    }).catch((err) => { stop(); if (onResultCb) onResultCb(null, recording); });
  }
  function downsample(buf, src, dst) { if (src === dst) return buf; const r = src / dst, n = Math.round(buf.length / r), o = new Float32Array(n); for (let i = 0; i < n; i++) o[i] = buf[Math.floor(i * r)]; return o; }

  /* 把 16k 单声道 Float32 样本打包成 WAV Blob（16bit PCM） */
  function encodeWav(samples, sampleRate) {
    const n = samples.length;
    const buf = new ArrayBuffer(44 + n * 2);
    const v = new DataView(buf);
    const writeStr = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    writeStr(36, 'data'); v.setUint32(40, n * 2, true);
    let off = 44;
    for (let i = 0; i < n; i++, off += 2) {
      let s = Math.max(-1, Math.min(1, samples[i]));
      v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return new Blob([buf], { type: 'audio/wav' });
  }

  function start(onResult, onStatus, onRecording) {
    onResultCb = onResult; onStatusCb = onStatus || null; onRecordingCb = onRecording || null;
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

  /* 解码任意音频 Blob（wav/webm 等）→ 16k 单声道 Float32 样本；供“长按录音换引擎重识别”使用 */
  async function recognizeBlob(blob) {
    const OffCtx = global.OfflineAudioContext || global.webkitOfflineAudioContext;
    const ctx = new OffCtx(1, 1, SR);
    const buf = await ctx.decodeAudioData((blob.arrayBuffer ? await blob.arrayBuffer() : await new Response(blob).arrayBuffer()));
    let ch0 = buf.getChannelData(0);
    ch0 = downsample(ch0, buf.sampleRate, SR);
    return recognizeSamples(ch0);
  }

  /* 调试钩子：直接识别一段 16k 样本（供验证/测试用） */
  function debugRecognize(samples) { return recognizeSamples(samples); }

  /* 模型是否已加载就绪（供设置页展示“线下模型”状态） */
  function getReady() { return !!session; }

  global.SenseVoiceAsr = { ensureLoaded, start, stop, debugRecognize, recognizeBlob, getReady, hasStoredModel };
})(window);
