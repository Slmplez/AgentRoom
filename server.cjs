// Local preview uses the same service as Electron; the desktop app needs no HTTP server.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { HcomService } = require('./lib/hcom-service.cjs');
const { catalog: avatarCatalog } = require('./renderer/avatars.js');
const port = Number(process.env.PORT || 4317);
const origin = `http://127.0.0.1:${port}`;
const service = new HcomService();
const clients = new Set();
service.on('state', state => { for (const res of clients) res.write(`data: ${JSON.stringify(state)}\n\n`); });
const api = {
  '/api/state': () => service.snapshot(), '/api/refresh': () => service.rescan(),
  '/api/send': body => service.send(body), '/api/rooms': body => service.createRoom(body),
  '/api/terminal': body => service.terminal(body.id), '/api/launch': body => service.launch(body),
  '/api/workspaces': body => service.createWorkspace(body),
  '/api/connections/save': body => service.saveConnection(body),
  '/api/connections/remove': body => service.removeConnection(body.id),
  '/api/connections/test': body => service.testConnection(body),
  '/api/usage': () => service.usage.snapshot(),
};
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    const url = new URL(req.url, origin);
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      clients.add(res); res.write(`data: ${JSON.stringify(service.snapshot())}\n\n`);
      req.on('close', () => clients.delete(res)); return;
    }
    if (api[url.pathname]) {
      const readOnly = ['/api/state', '/api/usage'].includes(url.pathname);
      if (req.method !== (readOnly ? 'GET' : 'POST')) { res.writeHead(405); return res.end(); }
      let text = '';
      for await (const chunk of req) { text += chunk; if (text.length > 65536) throw new Error('请求过大'); }
      const body = text ? JSON.parse(text) : {};
      const result = await api[url.pathname](body);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify(result));
    }
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    const name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
    if (!['index.html', 'styles.css', 'design-tokens.css', 'workbench.css', 'app.js', 'icons.js', 'avatars.js', 'connections.js', 'usage.js', ...avatarCatalog.map(item => item.src)].includes(name)) { res.writeHead(404); return res.end(); }
    const content = await fs.readFile(path.join(__dirname, 'renderer', name));
    res.writeHead(200, { 'Content-Type': mime[path.extname(name)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(content);
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(port, '127.0.0.1', async () => { console.log(`Agent Room preview: ${origin}`); await service.start(); });
process.on('SIGINT', () => { service.close(); for (const res of clients) res.end(); server.close(() => process.exit()); });
