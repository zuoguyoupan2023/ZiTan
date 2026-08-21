// Cloudflare Pages Function —— POST /api/asr 「字谈官方云端」语音识别代理（024 / 022 阶段 2）
//
// 用途：前端选「字谈官方云端」（vendor=zitan）时，录音（16k 单声道 WAV）发到本接口。
//       本函数用开发者自己的微软 Azure Key 转发识别，用户无需填任何 Key；
//       并按「每设备每天 25 次、单次 ≤30s」限流，保护每月 5 小时的 F0 免费额度。
//       Key 只存在于 Cloudflare 环境变量，永不下发前端、永不写入日志。
//
// 部署前（Cloudflare 控制台 / Pages 项目，详见 022 文档「阶段 3 操作手册」）：
//   1. Settings → Environment variables：
//        AZURE_SPEECH_KEY   = Azure 语音服务(F0) 的 Key1（Encrypt 加密保存）
//        AZURE_SPEECH_REGION= 区域，如 eastasia
//      （可选 ZITAN_DAILY_LIMIT 覆盖默认 25；可选 ZITAN_SALT 参与 IP 哈希）
//   2. Settings → Bindings → KV namespace bindings：
//        ZITAN_KV = ZITAN_QUOTA（计数用，TTL 48h 自动清理）
//   3. 本地联调：根目录建 .dev.vars 写入同名变量（已在 .gitignore），npx wrangler pages dev .
//
// 响应约定：
//   成功 → 200 { text } + 响应头 X-Quota-Remaining: <今日剩余次数>
//   429 { error: 'quota_exceeded' }          当天额度用完（前端文案 zitanQuotaMaxed）
//   503 { error: 'official_not_configured' } 未配 Key/KV（前端文案 zitanCloudDown）
//   413 { error: 'too_long' }                音频超 30s（前端文案 zitanTooLong）
//   502 { error: 'upstream_error' }          Azure 侧失败（详情只进日志）

const DAILY_LIMIT_DEFAULT = 25;        // 与前端 index.html 的 ZITAN_DAILY_LIMIT 保持一致
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 30s 的 16k 单声道 WAV ≈ 960KB，上限放宽到 2MB
const MAX_SECONDS = 30;                 // 单次最长秒数（按 WAV 头精确校验，防绕过前端）

const JSON_HEADERS = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };

function json(obj, status, remaining) {
  const headers = new Headers(JSON_HEADERS);
  if (typeof remaining === 'number') headers.set('X-Quota-Remaining', String(remaining));
  return new Response(JSON.stringify(obj), { status: status, headers: headers });
}

function pad2(n) { return (n < 10 ? '0' : '') + n; }

// 计数日以北京时间（UTC+8）为界，符合国内用户「每天」的直觉
function todayYmd() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return d.getUTCFullYear() + pad2(d.getUTCMonth() + 1) + pad2(d.getUTCDate());
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 设备标识：优先取前端 localStorage UUID（X-Device-Id）；没有/不合法则退回 IP 哈希（防清存储刷量）
async function getDeviceId(request, env) {
  const h = (request.headers.get('X-Device-Id') || '').trim();
  if (/^[A-Za-z0-9-]{8,64}$/.test(h)) return h.toLowerCase();
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const hex = await sha256Hex(ip + '|' + (env.ZITAN_SALT || 'zitan'));
  return 'ip-' + hex.slice(0, 24);
}

// 从 WAV 头算时长（秒）：ByteRate@28 / DataSize@40（与前端 blobToWav16k 手写的头对应）。
// 解析不了返回 null（此时跳过校验，交给 Azure 兜底），不让合法音频因解析问题被拒。
function wavSeconds(buf) {
  try {
    if (buf.byteLength < 44) return null;
    const v = new DataView(buf);
    const riff = String.fromCharCode(v.getUint8(0), v.getUint8(1), v.getUint8(2), v.getUint8(3));
    if (riff !== 'RIFF') return null;
    const byteRate = v.getUint32(28, true);
    const dataSize = v.getUint32(40, true);
    if (!byteRate || !dataSize) return null;
    return dataSize / byteRate;
  } catch (e) { return null; }
}

export async function onRequestPost(context) {
  const { request, env } = context;

  // 1. 基础校验：Content-Type 与大小
  const ctype = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!ctype.startsWith('audio/wav')) return json({ error: 'bad_content_type' }, 400);
  let buf;
  try {
    buf = await request.arrayBuffer();
  } catch (e) { return json({ error: 'bad_request' }, 400); }
  if (!buf || !buf.byteLength) return json({ error: 'empty_body' }, 400);
  if (buf.byteLength > MAX_BODY_BYTES) return json({ error: 'too_long' }, 413);

  // 2. 配置检查（先于扣次数：服务没配好不该烧用户的当日额度）
  const azKey = env.AZURE_SPEECH_KEY || '';
  const azRegion = String(env.AZURE_SPEECH_REGION || '').trim().toLowerCase();
  if (!azKey || !azRegion || !/^[a-z0-9]+$/.test(azRegion) || !env.ZITAN_KV) {
    return json({ error: 'official_not_configured' }, 503);
  }

  // 3. 时长二次校验（防绕过前端 30s 截断）
  const secs = wavSeconds(buf);
  if (secs !== null && secs > MAX_SECONDS + 1) return json({ error: 'too_long' }, 413);

  // 4. 每设备每日计数（KV 读→判→写；无原子自增，并发下极小概率多计 1 次，可接受，
  //    量大再换 Durable Object。先计数后转发：失败的尝试也占额，防止重试刷穿免费额度）
  const limit = parseInt(env.ZITAN_DAILY_LIMIT || '', 10) || DAILY_LIMIT_DEFAULT;
  const deviceId = await getDeviceId(request, env);
  const qkey = 'quota:' + todayYmd() + ':' + deviceId;
  let used = 0;
  try {
    const raw = await env.ZITAN_KV.get(qkey);
    used = raw ? (parseInt(raw, 10) || 0) : 0;
  } catch (e) { /* KV 抖动时放行本次但照常写入，避免整站不可用 */ }
  if (used >= limit) return json({ error: 'quota_exceeded' }, 429, 0);
  const remaining = Math.max(0, limit - used - 1);
  try {
    await env.ZITAN_KV.put(qkey, String(used + 1), { expirationTtl: 48 * 3600 });
  } catch (e) { /* 同上 */ }

  // 5. 转发 Azure 短音频 REST（语言白名单校验，默认 zh-CN）
  const url = new URL(request.url);
  const langParam = url.searchParams.get('language') || '';
  const lang = /^[a-z]{2}-[A-Za-z]{2,4}$/.test(langParam) ? langParam : 'zh-CN';
  let upstream, j = null;
  try {
    upstream = await fetch('https://' + azRegion + '.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=' + encodeURIComponent(lang), {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': azKey,
        'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
        'Accept': 'application/json'
      },
      body: buf
    });
    j = await upstream.json().catch(() => null);
  } catch (e) {
    console.error('[asr] azure fetch failed:', e && e.message);
    return json({ error: 'upstream_error' }, 502, remaining);
  }
  if (!upstream.ok || !j) {
    // 详情（配额耗尽/Key 无效等）只进 Workers 日志，不回传前端
    console.error('[asr] azure http', upstream.status, j && (j.error && j.error.message));
    return json({ error: 'upstream_error' }, 502, remaining);
  }

  // 6. 成功：NoMatch / InitialSilenceTimeout 等状态一律按「没听清」返回空文本
  const text = (j.RecognitionStatus === 'Success' && j.DisplayText) ? j.DisplayText : '';
  return json({ text: text }, 200, remaining);
}
