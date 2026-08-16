// sensevoice-test/smoke-test.mjs
// 冒烟测试：完全镜像浏览器 A2 链路 —— HTTP fetch 模型 → FS.writeFile → OfflineRecognizer → 识别 demo.wav
// 运行：cd ZiTan && python3 -m http.server 8000 &  然后  node sensevoice-test/smoke-test.mjs
import { createRequire } from 'node:module';
import fs from 'node:fs';
const require = createRequire(import.meta.url);

const BASE = 'http://127.0.0.1:8000';
const ROOT = new URL('..', import.meta.url).pathname; // ZiTan/

console.log('① 加载 wasm 胶水 + 引擎…');
const wasmGlue = require(ROOT + 'sensevoice/sherpa-onnx-wasm-nodejs.js');
const wasmModule = {};
await wasmGlue(wasmModule);
console.log('   引擎版本:', wasmModule._SherpaOnnxGetVersionStr
  ? wasmModule.UTF8ToString(wasmModule._SherpaOnnxGetVersionStr()) : '?');

const { OfflineRecognizer } = require(ROOT + 'sensevoice/sherpa-onnx-asr.js');

console.log('② A2 加载模型：fetch → FS_createDataFile（浏览器同款精简 FS API）…');
async function fetchToFS(url, fsName) {
  const t0 = Date.now();
  const res = await fetch(url);
  if (!res.ok) throw new Error('fetch 失败 ' + url + ' → ' + res.status);
  const buf = await res.arrayBuffer();
  // 精简版 FS：用 FS_createDataFile(parent, name, data, canRead, canWrite, canOwn)
  wasmModule.FS_createDataFile('/', fsName, new Uint8Array(buf), true, true, true);
  console.log('   /' + fsName, (buf.byteLength / 1048576).toFixed(1) + 'MB',
    ((Date.now() - t0) / 1000).toFixed(1) + 's');
}
await fetchToFS(BASE + '/sensevoice/model.int8.onnx', 'sense-voice.onnx');
await fetchToFS(BASE + '/sensevoice/tokens.txt', 'tokens.txt');
await fetchToFS(BASE + '/sensevoice/model.int8.onnx', '/sense-voice.onnx');
await fetchToFS(BASE + '/sensevoice/tokens.txt', '/tokens.txt');

console.log('③ 初始化 OfflineRecognizer…');
const rec = new OfflineRecognizer({
  modelConfig: {
    debug: 0,
    tokens: '/tokens.txt',
    senseVoice: { model: '/sense-voice.onnx', useInverseTextNormalization: 1 },
  },
}, wasmModule);
console.log('   就绪 ✓');

// 解析 demo.wav（16k 单声道 PCM16）
function wavToFloat32(buf) {
  const data = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let off = 12;
  while (off < buf.length) {
    const id = String.fromCharCode(buf[off], buf[off + 1], buf[off + 2], buf[off + 3]);
    const size = data.getUint32(off + 4, true);
    if (id === 'data') {
      const n = size / 2;
      const out = new Float32Array(n);
      let p = off + 8;
      for (let i = 0; i < n; i++, p += 2) out[i] = data.getInt16(p, true) / 32768;
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error('wav 无 data 块');
}

console.log('④ 识别 sensevoice-test/demo.wav …');
const wavBuf = fs.readFileSync(ROOT + 'sensevoice-test/demo.wav');
const samples = wavToFloat32(wavBuf);
const t0 = Date.now();
const stream = rec.createStream();
stream.acceptWaveform(16000, samples);
rec.decode(stream);
const r = rec.getResult(stream);
console.log('   耗时', ((Date.now() - t0) / 1000).toFixed(2) + 's');
console.log('   原始结果:', JSON.stringify(r));
console.log('   纯文本:', r.text);
stream.free();
rec.free();
