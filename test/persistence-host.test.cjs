const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { fork } = require('node:child_process');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { startPersistentHost } = require('../lib/persistence-host.cjs');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentroom-host-'));
  const rendererRoot = path.join(root, 'renderer'), directory = path.join(root, 'data');
  await fs.mkdir(rendererRoot); await fs.writeFile(path.join(rendererRoot, 'chat.html'), '<!doctype html><html data-mode="live"><body>真实持久讨论</body></html>');
  await fs.writeFile(path.join(rendererRoot, 'icons.js'), 'window.icons = {};');
  await fs.writeFile(path.join(rendererRoot, 'private.json'), '{"private":"must-not-serve"}');
  const hosts = [], children = [], privateReady = [];
  const observeFork = (...args) => { const child = fork(...args); children.push(child); child.on('message', msg => { if (msg.type === 'ready') privateReady.push(msg); }); return child; };
  t.after(async () => {
    for (const host of hosts) await host.close();
    for (const child of children) if (child.exitCode === null && child.signalCode === null && child.pid) { const ended = once(child, 'exit'); child.kill(); await ended; }
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith('agentroom-host-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
  });
  return { root, rendererRoot, directory, children, privateReady, observeFork,
    async start(options = {}) { const host = await startPersistentHost({ directory, rendererRoot, port: 0, fork: observeFork, ...options }); hosts.push(host); return host; },
  };
}
const cookieOf = response => response.headers.get('set-cookie')?.split(';')[0];
test('report publication requires explicit host opt-in and an Agent workspace', async t => {
  const env = await fixture(t);
  await assert.rejects(env.start({ agentReports: true }), { code: 'invalid_configuration' });
  let host = await env.start({ agentWorkspace: env.root });
  let auth = await session(host), boot = (await request(host, '/api/v1/bootstrap', auth.cookie)).value;
  assert.equal(boot.capabilities.artifactPublishing, false); assert.equal(boot.capabilities.readOnlyArtifacts, true);
  await host.close();
  host = await env.start({ agentWorkspace: env.root, agentReports: true }); auth = await session(host);
  boot = (await request(host, '/api/v1/bootstrap', auth.cookie)).value;
  assert.equal(boot.capabilities.artifactPublishing, true);
  assert.equal((await request(host, `/api/v1/rooms/${auth.info.roomId}/artifacts/missing/versions/1`, auth.cookie)).status, 404);
  assert.equal((await request(host, `/api/v1/rooms/${auth.info.roomId}/artifacts/missing/versions/1`)).status, 401);
});
async function session(host) { const response = await fetch(host.origin + '/api/persistence/session'); return { info: await response.json(), cookie: cookieOf(response) }; }
async function request(host, route, cookie, body, headers = {}) {
  const response = await fetch(host.origin + route, { method: body ? 'POST' : 'GET', headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  return { status: response.status, value: await response.json() };
}

test('real fork bootstrap exposes cookie identity only; initial room and identity persist across host restart', async t => {
  const env = await fixture(t); let host = await env.start();
  const page = await fetch(host.origin + '/'); const html = await page.text();
  assert.match(html, /data-mode="persistent"/); assert.match(page.headers.get('set-cookie'), /HttpOnly/); assert.match(page.headers.get('set-cookie'), /SameSite=Strict/);
  const first = await session(host);
  assert.deepEqual(Object.keys(first.info).sort(), ['authentication', 'backendId', 'localUserId', 'origin', 'roomId']);
  assert.equal(first.info.authentication, 'cookie'); assert.equal(first.info.origin, host.origin);
  const boot = (await request(host, '/api/v1/bootstrap', first.cookie)).value;
  const rooms = (await request(host, '/api/v1/rooms?' + new URLSearchParams({ workspaceId: boot.workspace.id }), first.cookie)).value;
  assert.equal(rooms.length, 1); assert.equal(rooms[0].title, '持久讨论'); assert.equal(rooms[0].id, first.info.roomId);
  assert.equal(JSON.stringify(first.info).includes(env.directory), false);
  assert.equal(JSON.stringify(first.info).includes(env.privateReady[0].token), false); assert.equal(html.includes(env.privateReady[0].token), false);
  await host.close(); assert.equal(env.children[0].exitCode, 0); assert.equal(env.children[0].signalCode, null);
  host = await env.start(); const second = await session(host);
  assert.equal(second.info.roomId, first.info.roomId); assert.equal(second.info.backendId, first.info.backendId); assert.equal(second.info.localUserId, first.info.localUserId);
  assert.notEqual(env.privateReady[0].token, env.privateReady[1].token);
  assert.equal((await request(host, '/api/v1/bootstrap', first.cookie)).status, 401);
});

test('host rejects missing cookies, cross-origin and same-site requests, forged Host and unlisted static files', async t => {
  const env = await fixture(t), host = await env.start(), auth = await session(host);
  assert.equal((await request(host, '/api/v1/bootstrap')).status, 401);
  assert.equal((await request(host, '/api/v1/bootstrap', 'ar_persistence_bad=bad')).status, 401);
  for (const headers of [{ Origin: 'https://evil.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'null' }]) {
    assert.equal((await request(host, '/api/v1/bootstrap', auth.cookie, undefined, headers)).status, 403);
    const response = await fetch(host.origin + '/api/persistence/session', { headers });
    assert.equal(response.status, 403); assert.equal(response.headers.get('set-cookie'), null); await response.text();
  }
  const hostStatus = await new Promise((resolve, reject) => { http.get(host.origin + '/api/persistence/session', { headers: { Host: 'evil.invalid' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); }).on('error', reject); });
  assert.equal(hostStatus, 403);
  assert.equal((await request(host, '/api/v1/bootstrap', auth.cookie, undefined, { Origin: host.origin, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  for (const route of ['/private.json', '/package.json', '/%2e%2e/private.json', '/client/persistent.mjs']) { const response = await fetch(host.origin + route); assert.equal(response.status, 404); await response.text(); }
  const response = await fetch(host.origin + '/icons.js'); assert.equal(response.status, 200); assert.match(response.headers.get('content-type'), /javascript/); await response.text();
  const duplicateCookie = auth.cookie + '; ' + auth.cookie;
  assert.equal((await request(host, '/api/v1/bootstrap', duplicateCookie)).status, 401);
});

test('proxy injects private authorization, preserves idempotency and disconnecting one SSE leaves the host alive', async t => {
  const env = await fixture(t), host = await env.start(), auth = await session(host);
  const boot = (await request(host, '/api/v1/bootstrap', auth.cookie)).value;
  const snapshot = (await request(host, `/api/v1/rooms/${auth.info.roomId}/snapshot`, auth.cookie)).value;
  const controller = new AbortController(); t.after(() => controller.abort());
  const stream = await fetch(host.origin + '/api/v1/events?' + new URLSearchParams({ roomId: auth.info.roomId, after: snapshot.cursor }), { headers: { Cookie: auth.cookie }, signal: controller.signal });
  assert.equal(stream.status, 200); assert.match(stream.headers.get('content-type'), /event-stream/);
  const key = randomUUID(), body = { workspaceId: boot.workspace.id, text: '真实代理消息' };
  const sent = await request(host, `/api/v1/rooms/${auth.info.roomId}/messages`, auth.cookie, body, { 'Idempotency-Key': key, Authorization: 'Bearer attacker-controlled' });
  assert.equal(sent.status, 200);
  const reader = stream.body.getReader(); const chunk = await reader.read(); assert.match(Buffer.from(chunk.value).toString(), /message.created/);
  controller.abort(); await reader.cancel().catch(() => {}); reader.releaseLock();
  assert.deepEqual((await request(host, `/api/v1/rooms/${auth.info.roomId}/messages`, auth.cookie, body, { 'Idempotency-Key': key })).value, sent.value);
  assert.equal((await request(host, '/api/v1/bootstrap', auth.cookie)).status, 200);
  const messages = (await request(host, `/api/v1/rooms/${auth.info.roomId}/messages`, auth.cookie)).value.messages;
  assert.equal(messages.length, 1); assert.equal(messages[0].authorId, auth.info.localUserId);
  await host.close(); await host.close();
  assert.ok(env.children.every(child => child.exitCode !== null || child.signalCode !== null));
  await assert.rejects(fetch(host.origin + '/api/persistence/session'));
});

test('a crashed backend returns unavailable and cannot fall back to a mock or silently respawn', async t => {
  const env = await fixture(t), host = await env.start(), auth = await session(host);
  const child = env.children[0], exited = once(child, 'exit'); child.kill(); await exited;
  const result = await request(host, '/api/v1/bootstrap', auth.cookie);
  assert.equal(result.status, 503); assert.equal(result.value.code, 'backend_unavailable');
  assert.equal((await request(host, '/api/persistence/session')).status, 503); assert.equal(env.children.length, 1);
});

test('missing runtime and occupied port fail actionably and leave no backend child running', async t => {
  const env = await fixture(t);
  await assert.rejects(env.start({ nodeExecutable: path.join(env.root, 'missing-node.exe') }), error => error.code === 'runtime_unavailable' && /Node.js >= 24.4.1/.test(error.message));
  const busy = http.createServer(); await new Promise(resolve => busy.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => busy.close(resolve)));
  await assert.rejects(env.start({ port: busy.address().port }), { code: 'host_start_failed' });
  assert.ok(env.children.every(child => !child.pid || child.exitCode !== null || child.signalCode !== null));
});

test('allowlisted static names cannot follow a symlink outside rendererRoot', async t => {
  const env = await fixture(t), outside = path.join(env.root, 'outside'); await fs.mkdir(outside); await fs.writeFile(path.join(outside, 'chat.js'), 'private-content');
  await fs.mkdir(path.join(env.rendererRoot, 'vendor')); await fs.symlink(outside, path.join(env.rendererRoot, 'vendor/chat'), 'junction');
  const host = await env.start(); const response = await fetch(host.origin + '/vendor/chat/chat.js');
  assert.equal(response.status, 404); assert.doesNotMatch(await response.text(), /private-content/);
  // Remove the link itself before fixture directory cleanup; never traverse the target.
  await fs.unlink(path.join(env.rendererRoot, 'vendor/chat'));
});

test('actual Node without SQLite gives an actionable startup error and exits before host rejection', async t => {
  const env = await fixture(t);
  await assert.rejects(env.start({ fork: (script, args, options) => env.observeFork(script, args, { ...options, execArgv: ['--no-experimental-sqlite'] }) }), error => error.code === 'runtime_unavailable' && /node:sqlite/.test(error.message) && /nodeExecutable/.test(error.message));
  assert.equal(env.children.length, 1); assert.equal(env.children[0].exitCode, 1);
});

test('host close interrupts a live SSE then waits for clean backend process exit', async t => {
  const env = await fixture(t), host = await env.start(), auth = await session(host);
  const snapshot = (await request(host, `/api/v1/rooms/${auth.info.roomId}/snapshot`, auth.cookie)).value;
  const controller = new AbortController(); t.after(() => controller.abort());
  const response = await fetch(host.origin + '/api/v1/events?' + new URLSearchParams({ roomId: auth.info.roomId, after: snapshot.cursor }), { headers: { Cookie: auth.cookie }, signal: controller.signal });
  const ended = response.text().catch(() => null);
  await host.close(); await ended;
  assert.equal(env.children[0].exitCode, 0); assert.equal(env.children[0].signalCode, null);
  // A subsequent real backend can open the same database immediately after close resolves.
  const next = await env.start(); assert.equal((await session(next)).info.roomId, auth.info.roomId);
});
