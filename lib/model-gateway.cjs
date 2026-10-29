const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { tlsOptions } = require('./connection-profiles.cjs');
const { UsageCollector } = require('./usage.cjs');

function upstreamUrl(profile, route) {
  return new URL(`${profile.baseUrl.replace(/\/+$/, '')}/${route.replace(/^\/+/, '')}`);
}
function authHeaders(profile, secrets) {
  if (profile.authMode === 'none') return {};
  if (!secrets.apiKey) throw new Error('连接方案缺少 API Key。');
  return profile.authMode === 'api-key' ? { 'x-api-key': secrets.apiKey } : { authorization: `Bearer ${secrets.apiKey}` };
}
function networkMessage(error) {
  if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY|DEPTH_ZERO|ALTNAME/.test(error.code || '')) return 'TLS 认证失败，请检查 CA、证书域名和客户端证书。';
  if (['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH'].includes(error.code)) return '无法连接网关，请检查地址、端口及服务状态。';
  if (['ETIMEDOUT', 'ECONNRESET'].includes(error.code)) return '网关连接超时或中断。';
  return '网关请求失败，请检查连接配置。';
}
async function inspectModels(profile, secrets) {
  const tls = await tlsOptions(profile, secrets);
  const url = upstreamUrl(profile, 'models');
  const started = Date.now();
  return new Promise(resolve => {
    const req = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', ...tls, headers: { accept: 'application/json', 'anthropic-version': '2023-06-01', ...authHeaders(profile, secrets) },
    }, res => {
      let body = '', large = false;
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; if (body.length > 2 * 1024 * 1024) { large = true; res.destroy(); } });
      const finish = () => {
        const status = res.statusCode;
        let models = [];
        if (!large && status >= 200 && status < 300) {
          try {
            const parsed = JSON.parse(body);
            const rows = Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed.models) ? parsed.models : null;
            if (!rows) throw new Error();
            models = [...new Set(rows.map(item => typeof item === 'string' ? item : item.id || item.name).filter(id => typeof id === 'string' && id.length <= 200 && !/[\r\n\0]/.test(id)))].slice(0, 1000);
            return resolve({ ok: true, reachable: true, status, models, latencyMs: Date.now() - started, message: `连接成功，读取到 ${models.length} 个模型。尚未执行模型推理。` });
          } catch { /* Do not echo upstream bodies; they can contain credentials. */ }
        }
        const message = status === 401 || status === 403 ? '网关已响应，但认证未通过，请检查 API Key 和认证方式。' : status === 404 || status === 405 ? '网关已响应，但不支持 GET /models；可以手动填写模型 ID。' : status >= 200 && status < 300 ? '网关已响应，但返回内容不是兼容的模型列表。' : `网关已响应 HTTP ${status}，请检查 API Base URL。`;
        resolve({ ok: false, reachable: true, status, models: [], latencyMs: Date.now() - started, message });
      };
      res.on('end', finish);
      res.on('error', () => resolve({ ok: false, reachable: true, status: res.statusCode, models: [], message: '模型列表读取中断或超过大小限制。' }));
    });
    req.setTimeout(12000, () => req.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })));
    req.on('error', error => resolve({ ok: false, reachable: false, models: [], message: networkMessage(error) }));
    req.end();
  });
}
function authorized(req, token) {
  const actual = req.headers.authorization?.replace(/^Bearer /i, '') || req.headers['x-api-key'] || '';
  const a = Buffer.from(actual), b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function startGateway(profile, secrets, observer = {}) {
  const tls = await tlsOptions(profile, secrets);
  const token = crypto.randomBytes(32).toString('hex');
  const sockets = new Set(), outgoing = new Set(), finalizers = new Set();
  let port, requestSequence = 0;
  const server = http.createServer((req, res) => {
    const fail = (status, message) => { if (!res.headersSent) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message, type: 'agent_room_gateway' } })); } else res.destroy(); };
    if (req.headers.host !== `127.0.0.1:${port}` || req.headers.origin || !authorized(req, token)) return fail(403, 'Local gateway authentication required.');
    let url;
    try { url = new URL(req.url, `http://127.0.0.1:${port}`); } catch { return fail(400, 'Invalid path.'); }
    const route = url.pathname.replace(/^\/v1\//, '').replace(/^\//, '');
    const sequence = ++requestSequence;
    const family = route.startsWith('responses') ? 'responses' : route.startsWith('chat/completions') ? 'chat' : route.startsWith('messages') ? 'anthropic' : null;
    const allowed = route === 'models' ? req.method === 'GET' : Boolean(family && (profile.protocol === 'multi' || family === profile.protocol) && req.method === 'POST' && /^(responses(?:\/compact)?|chat\/completions|messages(?:\/count_tokens)?)$/.test(route));
    if (!allowed || /%|\.\./.test(url.pathname)) return fail(404, 'This API route is not enabled for the connection profile.');
    const upstream = upstreamUrl(profile, route + url.search);
    let collector, httpStatus = 0, recorded = false;
    const record = interrupted => {
      if (recorded) return; recorded = true; finalizers.delete(record);
      if (route === 'models') return;
      const usage = collector?.finish() || null;
      try { observer.onUsage?.({ engine: observer.engine, model: collector?.model || observer.model || profile.model, profileId: profile.id, status: httpStatus, interrupted, completed: Boolean(collector?.completed && !collector.failed), usageComplete: Boolean(collector?.hasInput && collector?.hasOutput), route, requestSequence: sequence }, usage); } catch { /* Metrics never change delivery. */ }
    };
    finalizers.add(record);
    const headers = { ...authHeaders(profile, secrets) };
    for (const key of ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta']) if (req.headers[key]) headers[key] = req.headers[key];
    const request = (upstream.protocol === 'https:' ? https : http).request(upstream, { method: req.method, ...tls, headers }, response => {
      httpStatus = response.statusCode;
      collector = new UsageCollector(response.headers['content-type'] || '');
      const replyHeaders = {};
      for (const key of ['content-type', 'cache-control', 'retry-after', 'x-request-id', 'request-id', 'content-encoding']) if (response.headers[key]) replyHeaders[key] = response.headers[key];
      res.writeHead(response.statusCode, replyHeaders);
      response.on('data', chunk => collector.push(chunk));
      response.on('end', () => record(false));
      response.on('error', () => { record(true); res.destroy(); });
      response.pipe(res);
    });
    outgoing.add(request); request.on('close', () => outgoing.delete(request));
    request.setTimeout(300000, () => request.destroy(Object.assign(new Error(), { code: 'ETIMEDOUT' })));
    request.on('error', error => { record(true); fail(502, networkMessage(error)); });
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; if (bytes > 32 * 1024 * 1024) { fail(413, 'Request is too large.'); request.destroy(); } });
    req.on('aborted', () => { record(true); request.destroy(); });
    res.on('close', () => { if (!res.writableFinished) { record(true); request.destroy(); } });
    req.pipe(request);
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.requestTimeout = 300000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { port = server.address().port; resolve(); }); });
  return { baseUrl: `http://127.0.0.1:${port}`, token, profileId: profile.id,
    close() { for (const record of finalizers) record(true); for (const req of outgoing) req.destroy(); for (const socket of sockets) socket.destroy(); server.close(); } };
}
module.exports = { inspectModels, startGateway, upstreamUrl, authHeaders };
