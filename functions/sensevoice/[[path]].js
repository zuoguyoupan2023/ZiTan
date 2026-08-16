// Cloudflare Pages Function —— 代理 /sensevoice/* 到 R2 桶（wewalkworld-models/sensevoice/）
//
// 用途：前端 index.html 里默认可访问 /sensevoice/xxx，这批请求不再读本地静态文件，
//       而是由本函数从 R2 桶读取 model.int8.onnx / tokens.txt / meta.json / ort/*.wasm 返回，
//       让 228MB 模型走存储桶、避免 Pages 25MB 单文件上限、不膨胀 git。
//
// 部署前（Cloudflare 控制台 / Pages 项目 → Settings → Bindings → R2）：
//   给 Pages 项目绑定一个 R2 存储桶，绑定变量名固定为 MODELS，桶名为 wewalkworld-models。
//   （前端资源仍同站加载，模型路径 BASE='/sensevoice' 无需改。）
//
// 动态路由：文件路径 functions/sensevoice/[[path]].js 会捕获所有 /sensevoice/... 请求，
//           并把匹配到的剩余路径作为 [[path]] 传给 onRequest。

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // URL 形如 .../sensevoice/model.int8.onnx → 去掉前导 '/' 得相对路径
  // 桶内对象 key 带 sensevoice/ 前缀（与 URL pathname 一致），也可能有人平铺在桶根。
  const relPath = url.pathname.replace(/^\/+/, '');            // e.g. "sensevoice/model.int8.onnx"
  const normPath = relPath.replace(/^sensevoice\//, '');       // e.g. "model.int8.onnx"
  const keyCandidates = [relPath, normPath];                    // 先试带前缀，再试平铺

  try {
    const range = request.headers.get('range');
    // 有 Range → 分片读取（断点续传 / onnxruntime 分片拉取大模型必需）
    let object = null;
    for (const k of keyCandidates) {
      object = await env.MODELS.get(k, range ? { range } : undefined);
      if (object !== null) break;
    }
    if (object === null) {
      return new Response('Not Found: ' + relPath, { status: 404 });
    }

    const headers = new Headers();
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');

    // 按扩展名兜底 Content-Type（若 R2 上传时没设对，避免 onnx/wasm 被当文本）
    const ext = relPath.split('.').pop().toLowerCase();
    const TYPE = {
      onnx: 'application/octet-stream', wasm: 'application/wasm',
      js: 'text/javascript', mjs: 'text/javascript', json: 'application/json', txt: 'text/plain',
    };
    if (TYPE[ext]) headers.set('Content-Type', TYPE[ext]);

    if (!range) {
      // 全量：模型内容寻址可长缓存 immutable
      headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      object.writeHttpMetadata(headers);
      return new Response(object.body, { headers });
    } else {
      // 分片：206 + Content-Range
      headers.set('Content-Range', `bytes ${object.range.start}-${object.range.end}/${object.range.size}`);
      headers.set('Content-Length', String(object.range.end - object.range.start + 1));
      headers.set('Accept-Ranges', 'bytes');
      return new Response(object.body, { status: 206, headers });
    }
  } catch (err) {
    return new Response('R2 read failed: ' + (err && err.message), { status: 500 });
  }
}
