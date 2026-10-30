// Local preview uses the same service as Electron; the desktop app needs no HTTP server.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { HcomService } = require('./lib/hcom-service.cjs');
const { RpcRuntime } = require('./lib/rpc-runtime.cjs');
const port = Number(process.env.PORT || 4317);
const origin = `http://127.0.0.1:${port}`;
const dataDir = path.join(__dirname, '.data', 'web-rpc');
const service = new HcomService({ dataDir, runtime: new RpcRuntime({ dataDir }) });
const chatHandler = Promise.all([import('./lib/chat-api.mjs'), import('./lib/chat-http.mjs')])
  .then(([{ createChatApi }, { createChatHttpHandler }]) => createChatHttpHandler(createChatApi(service)));
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webp': 'image/webp', '.png': 'image/png' };
const server = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}` || (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    const url = new URL(req.url, origin);
    if (url.pathname.startsWith('/api/chat/')) return await (await chatHandler)(req, res);
    if (url.pathname.startsWith('/api/')) { res.writeHead(404); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    const name = url.pathname === '/' ? (process.argv.includes('--chat-ui') ? 'chat.html' : 'index.html') : decodeURIComponent(url.pathname).slice(1);
    const chatAsset = name === 'chat.html' || name === 'vendor/mentions.js' || /^vendor\/(?:chat|client)\/[a-zA-Z0-9_.-]+\.(?:js|css)$/.test(name);
    if (!chatAsset && !/^assets\/avatars\/[a-zA-Z0-9_-]+\.webp$/.test(name) && !['index.html', 'styles.css', 'design-tokens.css', 'workbench.css', 'app.js', 'icons.js', 'avatars.js', 'connections.js', 'usage.js', 'context.js', 'capabilities.js', 'capabilities.css', 'permissions.js', 'diffs.js', 'assets/brand/mark.svg', 'assets/brand/app.svg', 'assets/brand/mark.png', 'assets/brand/app.png', 'assets/brand/lockup-navy.png', 'assets/brand/lockup-light.png'].includes(name) && !/^vendor\/diffs\/[a-zA-Z0-9_.-]+\.js$/.test(name)) { res.writeHead(404); return res.end(); }
    const content = await fs.readFile(path.join(__dirname, 'renderer', name));
    res.writeHead(200, { 'Content-Type': mime[path.extname(name)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(content);
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: error.message }));
  }
});
server.listen(port, '127.0.0.1', async () => { console.log(`Agent Room preview: ${origin}`); await service.start(); });
let stopping = false;
async function shutdown() {
  if (stopping) return; stopping = true;
  await service.close(); server.closeAllConnections(); server.close(() => process.exit());
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
