// Cloudflare Pages Function —— GET /api/asr/upstreams 「字谈官方云端」上游额度状态（025 阶段 C）
//
// 注意路由：Pages Functions 按文件路径匹配，/api/asr/upstreams 必须是独立文件
// （functions/api/asr.js 只匹配 /api/asr 本身），故状态接口单独成文件。
//
// 返回：200 { tencent: 'ok'|'exhausted'|'unconfigured', azure: 'ok'|'exhausted'|'unconfigured' }
//   - exhausted：POST /api/asr 时探测到该上游返回「额度类」错误后写入的 KV 标记
//     （functions/api/asr.js 的 upmark:{vendor}，TTL 10 分钟自愈，防瞬时 QPS 误标长期锁死）
//   - unconfigured：环境变量未配置。前端对用户统一显示「有额度 / 没额度」，三态原始值留给开发者排查。

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function isMarkedExhausted(env, vendor) {
  return env.ZITAN_KV.get('upmark:' + vendor).then(v => v === 'exhausted').catch(() => false);
}

export async function onRequestGet(context) {
  const { env } = context;
  const tcOk = Boolean(env.TENCENT_SECRET_ID && env.TENCENT_SECRET_KEY);
  const azOk = Boolean((env.AZURE_SPEECH_KEY || '') && String(env.AZURE_SPEECH_REGION || '').trim());
  if (!env.ZITAN_KV) {
    // KV 未绑定 → 计数与标记都不可用，两个上游按未配置口径返回
    return new Response(JSON.stringify({ tencent: 'unconfigured', azure: 'unconfigured' }),
      { status: 200, headers: new Headers(JSON_HEADERS) });
  }
  const [tcMarked, azMarked] = await Promise.all([
    tcOk ? isMarkedExhausted(env, 'tencent') : Promise.resolve(false),
    azOk ? isMarkedExhausted(env, 'azure') : Promise.resolve(false)
  ]);
  return new Response(JSON.stringify({
    tencent: tcOk ? (tcMarked ? 'exhausted' : 'ok') : 'unconfigured',
    azure:   azOk ? (azMarked ? 'exhausted' : 'ok') : 'unconfigured'
  }), { status: 200, headers: new Headers(JSON_HEADERS) });
}
