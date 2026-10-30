const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { fork } = require('node:child_process');
const { randomBytes, randomUUID, timingSafeEqual } = require('node:crypto');

const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };
const staticNames = new Set(['chat.html', 'styles.css', 'design-tokens.css', 'workbench.css', 'icons.js', 'avatars.js', 'vendor/mentions.js', 'assets/brand/mark.svg', 'assets/brand/app.svg', 'assets/brand/mark.png', 'assets/brand/app.png', 'assets/brand/lockup-navy.png', 'assets/brand/lockup-light.png']);
const allowedStatic = name => /^assets\/fonts\/[a-zA-Z0-9_-]+\.woff2$/.test(name) || staticNames.has(name) || /^assets\/avatars\/[a-zA-Z0-9_-]+\.webp$/.test(name) || /^vendor\/(?:chat|client|diffs)\/[a-zA-Z0-9_.-]+\.(?:js|css|woff2)$/.test(name);
const error = (code, message, status = 503, outcome = 'rejected') => Object.assign(new Error(message), { code, status, outcome });

// Trusted host configuration only. The optional fork seam lets lifecycle tests observe
// a real child without exporting its PID or private IPC credentials to the browser.
async function startPersistentHost({ directory, agentWorkspace, agentReports = false, port = 4319, rendererRoot = path.join(__dirname, '../renderer'), nodeExecutable = process.versions.electron ? 'node' : process.execPath, startupTimeoutMs = 15000, shutdownTimeoutMs = 5000, fork: forkBackend = fork } = {}) {
  if (typeof agentReports !== 'boolean' || (agentReports && !agentWorkspace)) throw error('invalid_configuration', '报告发布需要显式启用 Agent 并指定只读工作目录。');
  if (typeof directory !== 'string' || !directory || !Number.isInteger(port) || port < 0 || port > 65535 || !Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 100 || !Number.isInteger(shutdownTimeoutMs) || shutdownTimeoutMs < 100) throw error('invalid_configuration', '请指定独立数据目录、有效端口和超时时间。');
  if (agentWorkspace !== undefined) {
    if (typeof agentWorkspace !== 'string' || !agentWorkspace.trim()) throw error('invalid_configuration', '请明确指定 Agent 的只读工作目录。');
    const info = await fs.stat(path.resolve(agentWorkspace)).catch(() => { throw error('agent_workspace_unavailable', 'Agent 工作目录不可访问，请检查路径和权限。'); });
    if (!info.isDirectory()) throw error('agent_workspace_unavailable', 'Agent 工作目录必须是目录。');
  }
  const root = await fs.realpath(rendererRoot).catch(() => { throw error('renderer_unavailable', '聊天页面不可用，请先运行 npm run build:renderer。'); });
  const htmlFile = await fs.realpath(path.join(root, 'chat.html')).catch(() => { throw error('renderer_unavailable', '聊天页面不可用，请先运行 npm run build:renderer。'); });
  if (!isInside(root, htmlFile)) throw error('renderer_unavailable', '聊天页面必须位于指定静态目录内。');
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  let child;
  try { child = forkBackend(path.join(__dirname, '../scripts/start-persistence-server.cjs'), ['--data-dir', path.resolve(directory), ...(agentWorkspace ? ['--agent-workspace', path.resolve(agentWorkspace)] : []), ...(agentReports ? ['--agent-reports'] : [])], { execPath: nodeExecutable, execArgv: [], env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true }); }
  catch { throw error('runtime_unavailable', '无法启动持久后端。请安装支持 node:sqlite 的 Node.js >= 24.4.1，并通过 nodeExecutable 指定 Node 可执行文件。'); }
  let exited = false, backendFailed = false, stopping = false, closePromise, origin, server;
  let stderr = '';
  child.stderr?.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
  const childDone = new Promise(resolve => {
    child.once('exit', () => { exited = true; backendFailed = true; resolve(); });
    child.once('error', () => { backendFailed = true; if (!child.pid) { exited = true; resolve(); } });
  });
  async function stopChild() {
    if (exited) return;
    if (child.connected) { try { child.send({ type: 'shutdown' }, () => {}); } catch {} }
    const killTimer = setTimeout(() => { if (!exited) child.kill(); }, shutdownTimeoutMs);
    const failTimer = setTimeout(() => { if (!exited) child.kill('SIGKILL'); }, shutdownTimeoutMs * 2);
    try { await childDone; } finally { clearTimeout(killTimer); clearTimeout(failTimer); }
  }
  async function close() {
    if (closePromise) return closePromise;
    stopping = true;
    closePromise = (async () => {
      if (server?.listening) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      await stopChild();
    })();
    return closePromise;
  }
  try {
    const credentials = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => done(error('runtime_timeout', '持久后端启动超时，请检查 Node.js 版本与独立数据目录。')), startupTimeoutMs);
      const message = value => {
        if (value?.type !== 'ready') return;
        let url;
        try { url = new URL(value.origin); } catch { return done(error('runtime_invalid', '持久后端启动响应无效。')); }
        if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.origin !== value.origin || !/^[a-f0-9]{64}$/.test(value.token)) return done(error('runtime_invalid', '持久后端启动响应无效。'));
        done(null, { origin: value.origin, token: value.token });
      };
      const exit = () => done(error('runtime_unavailable', /sqlite|Node.js|module/i.test(stderr) ? '持久后端需要支持 node:sqlite 的 Node.js >= 24.4.1，请通过 nodeExecutable 指定运行时。' : '持久后端启动失败，请检查独立数据目录权限、数据库版本及完整性。'));
      const failed = () => done(error('runtime_unavailable', '无法启动 Node.js。请安装 Node.js >= 24.4.1，并通过 nodeExecutable 指定运行时。'));
      function done(reason, value) { clearTimeout(timer); child.off('message', message); child.off('exit', exit); child.off('error', failed); reason ? reject(reason) : resolve(value); }
      child.on('message', message); child.once('exit', exit); child.once('error', failed);
      if (exited) exit();
    });
    // No child's stdout/stderr or token is returned to HTTP callers or logged.
    async function backend(route, body) {
      const response = await fetch(credentials.origin + '/api/v1' + route, { method: body ? 'POST' : 'GET', redirect: 'error', headers: { Authorization: 'Bearer ' + credentials.token, ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': 'agentroom:initial-discussion:v1' } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(startupTimeoutMs) });
      if (!response.ok) throw error('bootstrap_failed', '持久后端初始化失败，请检查数据库和本机会话。');
      return response.json();
    }
    const boot = await backend('/bootstrap');
    if (boot.schemaVersion !== 1 || !boot.databaseId || !boot.user?.id || !boot.workspace?.id) throw error('bootstrap_failed', '持久后端版本不兼容。');
    const rooms = await backend('/rooms?' + new URLSearchParams({ workspaceId: boot.workspace.id }));
    const roomId = rooms[0]?.id || (await backend('/rooms', { workspaceId: boot.workspace.id, title: '持久讨论' })).roomId;
    const identityFile = path.join(path.resolve(directory), 'host-identity.json');
    try { await fs.writeFile(identityFile, JSON.stringify({ backendId: randomUUID() }), { flag: 'wx', mode: 0o600 }); } catch (e) { if (e.code !== 'EEXIST') throw error('identity_unavailable', '无法保存宿主身份，请检查独立数据目录权限。'); }
    let backendId;
    try { ({ backendId } = JSON.parse(await fs.readFile(identityFile, 'utf8'))); } catch { throw error('identity_unavailable', '宿主身份记录不可读，请检查独立数据目录中的 host-identity.json。'); }
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(backendId || '') || !roomId) throw error('identity_unavailable', '宿主身份记录无效，请检查独立数据目录。');
    const cookieValue = randomBytes(32).toString('hex'); let cookieName;
    const trusted = req => req.headers.host === new URL(origin).host && (!req.headers.origin || req.headers.origin === origin) && (!req.headers['sec-fetch-site'] || ['same-origin', 'none'].includes(req.headers['sec-fetch-site']));
    function hasCookie(req) {
      const values = (req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(cookieName + '=')).map(value => value.slice(cookieName.length + 1));
      if (values.length !== 1) return false;
      const value = Buffer.from(values[0]), expected = Buffer.from(cookieValue);
      return value.length === expected.length && timingSafeEqual(value, expected);
    }
    const grant = res => res.setHeader('Set-Cookie', `${cookieName}=${cookieValue}; HttpOnly; SameSite=Strict; Path=/`);
    function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
    async function proxy(req, res, url) {
      const read = req.method === 'GET' && (/^\/api\/v1\/(?:bootstrap|rooms|events|operations)$/.test(url.pathname) || /^\/api\/v1\/rooms\/[^/]+\/(?:messages|snapshot|events)$/.test(url.pathname) || /^\/api\/v1\/operations\/[^/]+$/.test(url.pathname));
      const write = req.method === 'POST' && (url.pathname === '/api/v1/agent-memory/commands' || url.pathname === '/api/v1/rooms' || /^\/api\/v1\/rooms\/[^/]+\/(?:messages|local-tasks(?:\/[^/]+\/answers)?)$/.test(url.pathname));
      const localRead = req.method === 'GET' && /^\/api\/v1\/rooms\/[^/]+\/local-tasks(?:\/[^/]+(?:\/context)?)?$/.test(url.pathname);
      const artifactRead = req.method === 'GET' && /^\/api\/v1\/rooms\/[^/]+\/artifacts\/[^/]+\/versions(?:\/\d+)?$/.test(url.pathname);
      const query = req.method === 'POST' && url.pathname === '/api/v1/agent-memory/query';
      if (!read && !write && !localRead && !artifactRead && !query) throw error('not_found', '接口不存在。', 404);
      let body;
      if (write || query) {
        const chunks = []; let length = 0;
        for await (const chunk of req) { length += chunk.length; if (length > 128 * 1024) throw error('too_large', '请求内容过大。', 413); chunks.push(chunk); }
        body = Buffer.concat(chunks);
      }
      const headers = { Authorization: 'Bearer ' + credentials.token };
      if (write || query) { headers['Content-Type'] = req.headers['content-type'] || ''; headers['Content-Length'] = body.length; if (req.headers['idempotency-key']) headers['Idempotency-Key'] = req.headers['idempotency-key']; }
      const upstream = http.request(credentials.origin + url.pathname + url.search, { method: req.method, headers }, response => {
        res.writeHead(response.statusCode, { 'Content-Type': response.headers['content-type'] || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.flushHeaders(); response.on('error', () => res.destroy()); response.pipe(res);
      });
      const disconnect = () => upstream.destroy();
      res.once('close', disconnect); req.once('aborted', disconnect);
      upstream.once('error', () => {
        if (res.destroyed) return;
        if (res.headersSent) res.destroy();
        else json(res, 502, { code: 'backend_unavailable', message: '持久后端不可用，请重新启动服务并核查原请求。', outcome: write ? 'unknown' : 'rejected' });
      });
      upstream.once('close', () => { res.off('close', disconnect); req.off('aborted', disconnect); });
      if (write || query) upstream.setTimeout(15000, () => upstream.destroy());
      upstream.end(body);
    }
    server = http.createServer(async (req, res) => {
      res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
      try {
        if (!trusted(req)) throw error('forbidden', '请求来源不受信任。', 403);
        if (stopping || backendFailed) throw error('backend_unavailable', '持久后端已停止，请重新启动服务。');
        const url = new URL(req.url, origin);
        if (req.method === 'GET' && url.pathname === '/api/persistence/session') { grant(res); return json(res, 200, { origin, authentication: 'cookie', backendId, localUserId: boot.user.id, roomId }); }
        if (url.pathname.startsWith('/api/')) {
          if (!hasCookie(req)) throw error('unauthorized', '请先打开持久讨论页面建立本机会话。', 401);
          return await proxy(req, res, url);
        }
        if (req.method !== 'GET') throw error('method_not_allowed', '静态资源仅支持读取。', 405);
        const name = url.pathname === '/' ? 'chat.html' : decodeURIComponent(url.pathname).slice(1);
        if (!allowedStatic(name)) throw error('not_found', '资源不存在。', 404);
        const file = await fs.realpath(path.join(root, name)).catch(() => { throw error('not_found', '资源不存在，请确认前端已经构建。', 404); });
        if (!isInside(root, file)) throw error('not_found', '资源不存在。', 404);
        let content = await fs.readFile(file);
        if (name === 'chat.html') { content = Buffer.from(content.toString('utf8').replace(/data-mode\s*=\s*(["'])[^"']*\1/, 'data-mode="persistent"')); grant(res); }
        res.writeHead(200, { 'Content-Type': mime[path.extname(name)] || 'application/octet-stream' }); res.end(content);
      } catch (e) {
        if (res.headersSent || res.destroyed) { res.destroy(); return; }
        json(res, e.status || 500, { code: e.code && e.status ? e.code : 'host_error', message: e.status ? e.message : '持久宿主请求失败。', outcome: e.outcome || 'rejected' });
      }
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
    origin = `http://127.0.0.1:${server.address().port}`; cookieName = `ar_persistence_${server.address().port}`;
    if (backendFailed) throw error('backend_unavailable', '持久后端已停止，请重新启动服务。');
    return { origin, close };
  } catch (e) { await close(); if (e.status) throw e; throw error('host_start_failed', '持久宿主启动失败，请检查端口、Node.js 运行时和数据目录。'); }
}
function isInside(root, file) { const relative = path.relative(root, file); return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); }
module.exports = { startPersistentHost };
