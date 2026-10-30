import { randomUUID } from 'node:crypto';

export function createChatHttpHandler(api) {
  return async (req, res) => {
    const route = new URL(req.url, 'http://localhost').pathname;
    if (route === '/api/chat/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const unsubscribe = api.subscribe(event => res.write(`data: ${JSON.stringify(event)}\n\n`));
      res.on('close', unsubscribe);
      return;
    }
    if (!['/api/chat/snapshot', '/api/chat/commands'].includes(route)) { res.writeHead(404); res.end(); return; }
    const reading = route.endsWith('/snapshot');
    if (req.method !== (reading ? 'GET' : 'POST')) { res.writeHead(405); res.end(); return; }
    let input = { type: 'snapshot' };
    if (!reading) {
      try {
        const chunks = [];
        let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 256000) throw new Error('large'); chunks.push(chunk); }
        input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: { code: 'invalid_command', message: '聊天请求格式不正确或过大。', outcome: 'rejected', requestId: randomUUID() } }));
        return;
      }
    }
    const result = await api.request(input);
    res.writeHead(result.ok ? 200 : result.error.outcome === 'unknown' ? 503 : 400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(result));
  };
}
