// /api/tts-demo —— 001-azure.md 配套 demo.html 的合成代理（REST v1 通道）。
// 背景：部分网络环境到 *.tts.speech.microsoft.com 的 WebSocket 长连接不通而 HTTPS 正常；
//       Speech SDK 仅支持 WS，故由本函数代走 REST（浏览器 → 本函数 → 微软 → 音频流原路返回）。
//
// Key/Region 来源优先级：请求体显式传入 > 服务端环境变量 AZURE_SPEECH_KEY / AZURE_SPEECH_REGION
//   · 本地 dev：来自 .dev.vars　· 线上：来自 Pages 后台 Variables and Secrets
//
// 口令保护：若部署环境配置了 TTS_DEMO_TOKEN，请求头 X-Demo-Token 必须与之相等，
//   否则 403——防止公开端点被陌生人白嫖 F0 额度；本地未配置该变量时自动跳过校验。
export async function onRequestPost(context) {
  const env = context.env;
  let body;
  try { body = await context.request.json(); } catch (e) { return txt('bad_json', 400); }
  const ssml = String(body.ssml || '');
  const key = String(body.key || env.AZURE_SPEECH_KEY || '');
  const region = String(body.region || env.AZURE_SPEECH_REGION || '').trim().toLowerCase();

  const want = String(env.TTS_DEMO_TOKEN || '');
  if (want) {
    const got = String(context.request.headers.get('X-Demo-Token') || '');
    if (got !== want) return txt('forbidden: 口令缺失或不匹配', 403);
  }
  if (!ssml || !key || !region) return txt('missing_params: ssml 必填；key/region 需显式传入或在服务端环境变量中配置', 400);

  const upstream = await fetch('https://' + region + '.tts.speech.microsoft.com/cognitiveservices/v1', {
    method: 'POST',
    headers: {
      'Ocp-Apim-Subscription-Key': key,
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      'User-Agent': 'zitan-tts-demo'
    },
    body: ssml
  });
  if (!upstream.ok) {
    const t = await upstream.text();
    return new Response(t || ('upstream_http_' + upstream.status), {
      status: upstream.status,
      headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }
    });
  }
  return new Response(upstream.body, {
    status: 200,
    headers: { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' }
  });
}

/* 状态探测：demo 启动时查询服务端是否已配好环境变量、是否启用了口令 */
export async function onRequestGet(context) {
  const env = context.env;
  return new Response(JSON.stringify({
    envKey: Boolean(env.AZURE_SPEECH_KEY),
    envRegion: String(env.AZURE_SPEECH_REGION || '').trim().toLowerCase(),
    needToken: Boolean(env.TTS_DEMO_TOKEN)
  }), { headers: { 'Content-Type': 'application/json' } });
}

function txt(s, code) {
  return new Response(s, { status: code, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
