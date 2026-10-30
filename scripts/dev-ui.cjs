const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { buildRenderer } = require('./build-renderer.cjs');
const renderer = path.resolve(__dirname, '../renderer');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' };

// A static-only development server. Never imports the production service or native runtime.
function createPreviewServer({ mode = 'mock' } = {}) {
  return http.createServer(async (req, res) => {
    try {
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
      const url = new URL(req.url, 'http://127.0.0.1');
      let relative = decodeURIComponent(url.pathname).replace(/^\//, '');
      if (['', 'index.html', 'chat.html'].includes(relative)) relative = 'chat.html';
      if (relative === 'workbench.html') relative = 'index.html';
      const file = path.resolve(renderer, relative);
      if (!file.startsWith(renderer + path.sep) || !mime[path.extname(file)] || /[\\]/.test(relative) || relative.startsWith('api/')) { res.writeHead(404); res.end(); return; }
      let content = await fs.readFile(file);
      if (relative === 'chat.html' && mode === 'mock') content = Buffer.from(content.toString().replace('data-mode="live"', 'data-mode="mock"'));
      if (relative === 'index.html' && mode === 'mock') content = Buffer.from(content.toString().replace('<html', '<html data-mode="mock"'));
      res.writeHead(200, { 'Content-Type': mime[path.extname(file)], 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
}
module.exports = { createPreviewServer };
if (require.main === module) (async () => {
  const watcher = await buildRenderer({ watch: true });
  const server = createPreviewServer();
  const port = Number(process.env.UI_PORT || 4318);
  server.on('error', async error => { console.error(error.message); await watcher.dispose(); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => console.log(`Agent Room · 模拟开发 http://127.0.0.1:${port}\nSource changes rebuild automatically; refresh the browser to see changes.`));
  const stop = () => { server.close(); void watcher.dispose(); };
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
})().catch(error => { console.error(error); process.exitCode = 1; });
