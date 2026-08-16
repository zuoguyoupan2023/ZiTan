// cdp-verify.mjs — 用 CDP 驱动 headless Chrome 验证浏览器识别链路
// 用法: node sensevoice-test/cdp-verify.mjs <url> [超时秒数]
const url = process.argv[2] || 'http://127.0.0.1:8000/sensevoice-test.html';
const timeoutMs = (parseInt(process.argv[3]) || 120) * 1000;

// 1. 找到页面 target
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
if (!page) { console.error('找不到 page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
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

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url });
console.log('已导航到:', url);

const t0 = Date.now();
let lastStatus = '';
let lastOut = '';
let lastLog = '';
while (Date.now() - t0 < timeoutMs) {
  await new Promise((r) => setTimeout(r, 1500));
  const res = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      status: document.getElementById('status')?.textContent || '',
      out: document.getElementById('out')?.textContent || '',
      log: document.getElementById('log')?.textContent || '',
      title: document.title
    })`,
    returnByValue: true,
  });
  try {
    const d = JSON.parse(res.result.value);
    lastStatus = d.status; lastOut = d.out; lastLog = d.log;
    console.log(`[${((Date.now()-t0)/1000).toFixed(0)}s] status: ${d.status.slice(0, 60)}`);
    // 完成条件：自动演示跑完（识别耗时日志出现）或出错
    if (/识别耗时|未识别到内容/.test(d.log) || /失败|err/.test(d.status)) {
      console.log('\n==== 识别结果 ====');
      console.log('status:', d.status);
      console.log('out(文本):', d.out);
      console.log('==== 日志 ====');
      console.log(d.log.slice(0, 3000));
      process.exit(0);
    }
  } catch (e) { console.log('evaluate 失败', e.message); }
}
console.log('\n超时。最后状态:');
console.log('status:', lastStatus);
console.log('out:', lastOut);
console.log('==== 日志(尾部) ====');
console.log(lastLog.slice(-2000));
process.exit(1);
