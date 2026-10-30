import http from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { persistenceError as fail } from '../../contracts/persistence.mjs';

export async function startPersistenceHttp({ runtime, port = 0, token = randomBytes(32).toString('hex') }) {
  if (!Number.isInteger(port) || port < 0 || port > 65535 || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid persistence listener configuration.');
  const expected = Buffer.from('Bearer ' + token);
  let origin;
  async function body(req) {
    if ((req.headers['content-type'] || '').split(';')[0].trim() !== 'application/json') throw fail('invalid_request', '需要 JSON 请求。', 415);
    let size = 0; const chunks = [];
    for await (const chunk of req) { size += chunk.length; if (size > 128 * 1024) throw fail('too_large', '请求内容过大。', 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail('invalid_request', 'JSON 无效。'); }
  }
  function number(url, key) { if (!url.searchParams.has(key)) return undefined; const s = url.searchParams.get(key); if (!/^\d+$/.test(s)) throw fail('invalid_request', '分页参数无效。'); return Number(s); }
  const server = http.createServer(async (req, res) => {
    const requestId = randomUUID();
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin)) throw fail('forbidden', '请求来源不受信任。', 403);
      const supplied = Buffer.from(req.headers.authorization || '');
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw fail('unauthorized', '请建立本机会话。', 401);
      const url = new URL(req.url, origin), actor = runtime.owner;
      if (req.method === 'GET' && url.pathname === '/api/v1/events') {
        const controller = new AbortController();
        const stream = runtime.watch({ roomId: url.searchParams.get('roomId'), after: url.searchParams.get('after') ?? undefined }, actor, { signal: controller.signal });
        res.on('close', () => { controller.abort(); stream.close(); });
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders();
        const write = frame => {
          if (res.destroyed) return false;
          if (res.writableLength + Buffer.byteLength(frame) > 1024 * 1024) { res.destroy(); return false; }
          res.write(frame); return true;
        };
        const heartbeat = setInterval(() => write(': heartbeat\n\n'), 15000); heartbeat.unref?.();
        try {
          for await (const frame of stream) {
            if (!write(`data: ${JSON.stringify(frame)}\n\n`)) break;
            // Let socket writes progress during a large backlog. Microtask-only iteration
            // would classify even a healthy peer as slow before the first I/O turn.
            if (res.writableNeedDrain) await new Promise(resolve => setImmediate(resolve));
          }
        } catch (error) {
          write(`event: error\ndata: ${JSON.stringify({ code: error.status ? error.code : 'unavailable' })}\n\n`);
        } finally { clearInterval(heartbeat); controller.abort(); stream.close(); res.end(); }
        return;
      }
      let result;
      const taskRoute = /^\/api\/v1\/rooms\/([^/]+)\/local-tasks(?:\/([^/]+)(\/answers)?)?$/.exec(url.pathname);
      const match = /^\/api\/v1\/rooms\/([^/]+)\/(messages|events|snapshot)$/.exec(url.pathname);
      if (taskRoute && req.method === 'GET' && !taskRoute[3]) result = runtime.query({ type: taskRoute[2] ? 'localTask' : 'localTasks', roomId: decodeURIComponent(taskRoute[1]), ...(taskRoute[2] ? { taskId: decodeURIComponent(taskRoute[2]) } : {}) }, actor);
      else if (taskRoute && req.method === 'POST' && (!taskRoute[2] || taskRoute[3])) {
        const input = await body(req);
        if (!input || typeof input !== 'object' || Array.isArray(input) || ['type', 'key', 'roomId', 'taskId'].some(k => Object.hasOwn(input, k))) throw fail('invalid_request', '路由字段不能由正文覆盖。');
        result = runtime.execute({ ...input, type: taskRoute[3] ? 'answerLocalQuestion' : 'createLocalTask', key: req.headers['idempotency-key'], roomId: decodeURIComponent(taskRoute[1]), ...(taskRoute[2] ? { taskId: decodeURIComponent(taskRoute[2]) } : {}) }, actor);
      }
      else if (req.method === 'GET' && url.pathname === '/api/v1/bootstrap') result = runtime.query({ type: 'bootstrap' }, actor);
      else if (req.method === 'GET' && url.pathname === '/api/v1/rooms') result = runtime.query({ type: 'rooms', workspaceId: url.searchParams.get('workspaceId') }, actor);
      else if (req.method === 'POST' && (url.pathname === '/api/v1/rooms' || (match && match[2] === 'messages'))) {
        const input = await body(req);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('invalid_request', '请求必须是对象。');
        if (['type', 'key', 'roomId'].some(k => Object.hasOwn(input, k))) throw fail('invalid_request', '请求路由字段不能在正文覆盖。');
        const command = { ...input, type: match ? 'sendDiscussion' : 'createRoom', key: req.headers['idempotency-key'] };
        if (match) command.roomId = decodeURIComponent(match[1]);
        result = runtime.execute(command, actor);
      } else if (req.method === 'GET' && match) {
        const roomId = decodeURIComponent(match[1]);
        result = runtime.query(match[2] === 'snapshot' ? { type: 'snapshot', roomId } : match[2] === 'messages' ? { type: 'messages', roomId, limit: number(url, 'limit'), beforeSequence: number(url, 'beforeSequence'), upperBound: number(url, 'upperBound') } : { type: 'events', roomId, after: url.searchParams.get('after') ?? undefined, limit: number(url, 'limit') }, actor);
      } else if (req.method === 'GET' && /^\/api\/v1\/operations\/[^/]+$/.test(url.pathname)) result = runtime.query({ type: 'operation', operationId: decodeURIComponent(url.pathname.split('/').at(-1)) }, actor);
      else if (req.method === 'GET' && url.pathname === '/api/v1/operations') result = runtime.query({ type: 'receipt', workspaceId: url.searchParams.get('workspaceId'), commandType: url.searchParams.get('commandType'), key: url.searchParams.get('key') }, actor);
      else throw fail('not_found', '接口不存在。', 404);
      res.end(JSON.stringify(result));
    } catch (e) {
      res.statusCode = e.status || 500;
      res.end(JSON.stringify({ code: e.code && e.status ? e.code : 'internal_error', message: e.status ? e.message : '请求处理失败。', outcome: e.outcome || 'unknown', requestId }));
    }
  });
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, token, async close() { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); } };
}
