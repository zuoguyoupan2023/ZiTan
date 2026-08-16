// cdp-diag.mjs — 抓取页面 console 和异常
const url = process.argv[2] || 'http://127.0.0.1:8000/sensevoice-test.html';
const targets = await (await fetch('http://127.0.0.1:9222/json')).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
function send(method, params = {}) {
  return new Promise((res, rej) => { const mid = ++id; pending.set(mid, { res, rej });
    ws.send(JSON.stringify({ id: mid, method, params })); });
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) { const p = pending.get(msg.id); pending.delete(msg.id); msg.error ? p.rej(new Error(msg.error.message)) : p.res(msg.result); return; }
  if (msg.method === 'Runtime.consoleAPICalled') {
    const args = msg.params.args.map(a => a.value ?? a.description ?? '').join(' ');
    console.log('[console]', msg.params.type, ':', args.slice(0, 300));
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    console.log('[exception]', JSON.stringify(msg.params.exceptionDetails).slice(0, 500));
  }
  if (msg.method === 'Network.loadingFailed') {
    console.log('[net-fail]', msg.params.errorText, msg.params.requestId);
  }
};
await new Promise(r => ws.onopen = r);
await send('Runtime.enable');
await send('Network.enable');
await send('Page.enable');
await send('Page.navigate', { url });
console.log('navigated, watching 20s…');
await new Promise(r => setTimeout(r, 20000));
const res = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    typeofModule: typeof Module,
    expectedDataFileDownloads: (window.Module&&Module.expectedDataFileDownloads),
    wasmReady: !!(window.Module && Module.asm),
    status: document.getElementById('status')?.textContent,
    netEntries: performance.getEntriesByType('resource').map(e => e.name).filter(n=>n.includes('sensevoice')).slice(0,10)
  })`,
  returnByValue: true,
});
console.log('\n==== 诊断 ====');
console.log(res.result.value);
process.exit(0);
