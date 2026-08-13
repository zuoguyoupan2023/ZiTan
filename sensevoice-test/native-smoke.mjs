// native-smoke.mjs — 原生 Web Speech API 集成冒烟测试（CDP 驱动 headless Chrome）
// 前置：python3 -m http.server 8000 &  +  chrome --headless=new --remote-debugging-port=9222 --user-data-dir=/tmp/...
// 用法：node sensevoice-test/native-smoke.mjs
// 覆盖：①模块存在 ②原生优先路径（不下载 228MB 模型即出字） ③network 错误回退本地

const URL = 'http://127.0.0.1:8000/index.html';
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('找不到 page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id; pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id); pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
  }
};
await new Promise((r) => (ws.onopen = r));
await send('Runtime.enable'); await send('Page.enable');

const errors = [];
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.exceptionThrown')
    errors.push('EXC: ' + (msg.params.exceptionDetails?.exception?.description || msg.params.exceptionDetails?.text));
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error')
    errors.push('CONSOLE: ' + msg.params.args.map((a) => a.value ?? a.description).join(' '));
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 页面脚本执行前注入：mock SpeechRecognition + 统计模型 fetch 次数
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
  window.__srMode = 'ok';
  window.SpeechRecognition = class {
    constructor(){ this.lang=''; this.continuous=false; this.interimResults=false; this.maxAlternatives=1; }
    start(){
      this.onstart && this.onstart();
      const m = window.__srMode;
      if (m === 'ok') {
        setTimeout(() => { this.onresult && this.onresult({ resultIndex:0, results:[{ isFinal:true, 0:{ transcript:'你好原生' } }] }); this.onend && this.onend(); }, 400);
      } else if (m === 'network') {
        setTimeout(() => { this.onerror && this.onerror({ error:'network' }); this.onend && this.onend(); }, 200);
      }
    }
    abort(){ this.onend && this.onend(); }
  };
  window.__modelFetches = 0;
  const _f = window.fetch.bind(window);
  window.fetch = (...a) => { if (String(a[0]).includes('model.int8.onnx')) window.__modelFetches++; return _f(...a); };
  window.__toasts = [];
  document.addEventListener('DOMContentLoaded', () => {
    const el = document.getElementById('toast');
    if (!el) return;
    new MutationObserver(() => window.__toasts.push(el.textContent))
      .observe(el, { childList: true, characterData: true, subtree: true });
  });
` });

await send('Page.navigate', { url: URL });
await sleep(1200);

const evalJson = async (expr) => JSON.parse((await send('Runtime.evaluate', { expression: expr, returnByValue: true })).result.value);

// ① 模块存在性 + 环境信息
const m = await evalJson(`JSON.stringify({
  nativeAsr: typeof NativeAsr, senseVoiceAsr: typeof SenseVoiceAsr,
  info: NativeAsr.info ? NativeAsr.info() : null,
  micBtn: !!document.getElementById('micBtn')
})`);
console.log('① 模块检测:', JSON.stringify(m));

// ② 原生优先：点麦克风 → 走 native，不触发模型下载，填入「你好原生」
await send('Runtime.evaluate', { expression: `document.getElementById('micBtn').click(); true`, returnByValue: true });
await sleep(1000);
const o1 = await evalJson(`JSON.stringify({
  text: document.getElementById('text').value,
  rec: document.getElementById('micBtn').classList.contains('rec'),
  modelFetches: window.__modelFetches,
  toasts: window.__toasts.join('|')
})`);
console.log('② 原生优先:', JSON.stringify({ text: o1.text, rec: o1.rec, modelFetches: o1.modelFetches }), '· toasts:', o1.toasts);

// ③ 回退本地：mock 置为网络错误 + monkey-patch 本地 ASR → 应回退并填入「本地兜底」
await send('Runtime.evaluate', {
  expression: `
    window.__srMode = 'network';
    window.SenseVoiceAsr.ensureLoaded = () => Promise.resolve();
    window.SenseVoiceAsr.start = (cb) => { setTimeout(() => cb('本地兜底'), 500); };
    document.getElementById('text').value = '';
    document.getElementById('micBtn').click(); true`, returnByValue: true,
});
await sleep(1000);
const o2 = await evalJson(`JSON.stringify({
  text: document.getElementById('text').value,
  rec: document.getElementById('micBtn').classList.contains('rec'),
  toasts: window.__toasts.join('|')
})`);
console.log('③ 回退本地:', JSON.stringify({ text: o2.text, rec: o2.rec }), '· toasts:', o2.toasts);

console.log('④ 运行时异常:', errors.length ? errors.join('\n') : '无 ✓');
ws.close();

const pass =
  m.nativeAsr === 'object' && m.senseVoiceAsr === 'object' && m.micBtn === true && m.info.secure === true &&
  o1.text === '你好原生' && o1.rec === false && o1.modelFetches === 0 && /联网识别中/.test(o1.toasts) &&
  o2.text === '本地兜底' && o2.rec === false && /联网识别不可用/.test(o2.toasts) &&
  errors.length === 0;
console.log(pass ? '\n✅ SMOKE PASS' : '\n❌ SMOKE FAIL');
process.exit(pass ? 0 : 1);
