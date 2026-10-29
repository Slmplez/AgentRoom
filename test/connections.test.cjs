const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const { ConnectionProfiles, validateProfile } = require('../lib/connection-profiles.cjs');
const { inspectModels, startGateway } = require('../lib/model-gateway.cjs');
const { engineConnection } = require('../lib/engine-connections.cjs');
const { HcomService, hcomEnvironment } = require('../lib/hcom-service.cjs');

const base = { name: 'Test gateway', protocol: 'multi', baseUrl: 'http://127.0.0.1:3425/v1', model: 'test/model', authMode: 'bearer', contextWindow: 128000, maxTokens: 8192 };
test('launch environment strips enclosing agent identity while retaining isolated overrides', () => {
  const parent = { CODEX_THREAD_ID: 'parent', CI: '1', HCOM_LAUNCHED: '1', Path: 'old', OPENCODE_CONFIG_CONTENT: 'old' };
  const env = hcomEnvironment(parent, 'new-path', { OPENCODE_CONFIG_CONTENT: 'new' });
  assert.equal(env.CODEX_THREAD_ID, undefined); assert.equal(env.CI, undefined); assert.equal(env.HCOM_LAUNCHED, undefined);
  assert.equal(env.OPENCODE_CONFIG_CONTENT, 'new'); assert.equal(parent.OPENCODE_CONFIG_CONTENT, 'old');
  assert.equal(env.PATH, 'new-path'); assert.equal(env.Path, undefined);
});
async function temp(t) { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-connections-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; }
function testEncryption() {
  // Exercise storage boundaries with authenticated encryption; Electron safeStorage has a separate desktop smoke check.
  const key = crypto.randomBytes(32);
  return { isEncryptionAvailable: () => true,
    encryptString(text) { const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, iv); const bytes = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), bytes]); },
    decryptString(bytes) { const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12)); decipher.setAuthTag(bytes.subarray(12, 28)); return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(); } };
}
async function listen(t, server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `${server instanceof https.Server ? 'https' : 'http'}://127.0.0.1:${server.address().port}/v1`;
}
test('profile validation rejects credentials in URL, invalid protocols and incomplete TLS configuration', () => {
  assert.throws(() => validateProfile({ ...base, baseUrl: 'https://user:secret@api.test/v1' }), /认证信息/);
  assert.throws(() => validateProfile({ ...base, baseUrl: 'file:///etc/passwd' }), /HTTP/);
  assert.throws(() => validateProfile({ ...base, protocol: '__proto__' }), /协议/);
  assert.throws(() => validateProfile({ ...base, clientCertPath: path.resolve('test.pem') }), /同时提供/);
  assert.throws(() => validateProfile({ ...base, caPath: path.resolve('ca.pem') }), /HTTPS/);
  assert.throws(() => validateProfile({ ...base, maxTokens: 256000 }), /token/);
});
test('encrypted profiles persist without leaking secrets; blank edits retain a key and clearing removes it', async t => {
  const dir = await temp(t), storage = testEncryption();
  const store = new ConnectionProfiles({ dataDir: dir, secretStorage: storage }); await store.load();
  const secret = 'TEST-API-KEY-not-a-real-key';
  const id = await store.save({ ...base, apiKey: secret });
  assert.ok(!(await fs.readFile(path.join(dir, 'connections.json'), 'utf8')).includes(secret));
  assert.ok(!JSON.stringify(store.list()).includes(secret));
  const reloaded = new ConnectionProfiles({ dataDir: dir, secretStorage: storage }); await reloaded.load();
  await reloaded.save({ ...base, id, apiKey: '', name: 'renamed' });
  assert.equal(reloaded.get(id).secrets.apiKey, secret);
  await reloaded.save({ ...base, id, apiKey: '', clearApiKey: true, authMode: 'none' });
  assert.equal(reloaded.get(id).secrets.apiKey, undefined);
  const unavailable = new ConnectionProfiles({ dataDir: await temp(t) });
  await assert.rejects(unavailable.save({ ...base, apiKey: secret }), /加密存储不可用/);
});
test('model discovery preserves API paths, uses the configured authentication and never follows redirects', async t => {
  let seen;
  const baseUrl = await listen(t, http.createServer((req, res) => { seen = { url: req.url, key: req.headers.authorization }; res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'custom/model' }, { id: 'custom/model' }] })); }));
  const result = await inspectModels({ ...base, baseUrl }, { apiKey: 'test-upstream' });
  assert.deepEqual(result.models, ['custom/model']); assert.equal(result.ok, true);
  assert.deepEqual(seen, { url: '/v1/models', key: 'Bearer test-upstream' });
  const redirect = await listen(t, http.createServer((req, res) => { res.writeHead(302, { location: 'https://example.invalid/key' }); res.end(); }));
  const rejected = await inspectModels({ ...base, baseUrl: redirect }, { apiKey: 'test-upstream' });
  assert.equal(rejected.ok, false); assert.equal(rejected.status, 302);
});
test('custom CA is required and mTLS succeeds only with the configured client certificate', async t => {
  const caPath = path.join(__dirname, 'fixtures/tls-cert.pem'), keyPath = path.join(__dirname, 'fixtures/tls-key.pem');
  const cert = await fs.readFile(caPath), key = await fs.readFile(keyPath);
  const baseUrl = await listen(t, https.createServer({ cert, key, requestCert: true, rejectUnauthorized: true, ca: cert }, (req, res) => { res.end(JSON.stringify({ data: [{ id: 'tls-test-model' }] })); }));
  const profile = { ...base, baseUrl };
  assert.equal((await inspectModels(profile, { apiKey: 'test' })).ok, false);
  assert.equal((await inspectModels({ ...profile, caPath }, { apiKey: 'test' })).ok, false);
  const success = await inspectModels({ ...profile, caPath, clientCertPath: caPath, clientKeyPath: keyPath }, { apiKey: 'test' });
  assert.equal(success.ok, true); assert.deepEqual(success.models, ['tls-test-model']);
  const noClientRequired = await listen(t, https.createServer({ cert, key }, (req, res) => { res.end(JSON.stringify({ data: [] })); }));
  assert.equal((await inspectModels({ ...base, baseUrl: noClientRequired, caPath }, { apiKey: 'test' })).ok, true);
  const mismatch = await inspectModels({ ...base, baseUrl: noClientRequired.replace('127.0.0.1', 'localhost'), caPath }, { apiKey: 'test' });
  assert.equal(mismatch.ok, false);
});
test('local bridge authenticates callers, streams bytes, replaces auth and rejects unsupported protocol routes', async t => {
  const received = [];
  const baseUrl = await listen(t, http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    received.push({ path: req.url, auth: req.headers.authorization, local: req.headers['x-api-key'], body });
    res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"delta":"hello"}\n\n'); setImmediate(() => res.end('data: [DONE]\n\n'));
  }));
  const gateway = await startGateway({ ...base, baseUrl, protocol: 'responses' }, { apiKey: 'REAL-UPSTREAM-TEST-KEY' }); t.after(() => gateway.close());
  assert.equal((await fetch(`${gateway.baseUrl}/v1/responses`, { method: 'POST', body: '{}' })).status, 403);
  assert.equal((await fetch(`${gateway.baseUrl}/v1/messages`, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}` }, body: '{}' })).status, 404);
  assert.equal((await fetch(`${gateway.baseUrl}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, origin: 'https://other.test' }, body: '{}' })).status, 403);
  const response = await fetch(`${gateway.baseUrl}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' }, body: '{"model":"custom"}' });
  assert.equal(response.status, 200); assert.equal(await response.text(), 'data: {"delta":"hello"}\n\ndata: [DONE]\n\n');
  assert.deepEqual(received, [{ path: '/v1/responses', auth: 'Bearer REAL-UPSTREAM-TEST-KEY', local: undefined, body: '{"model":"custom"}' }]);
});
test('all four engine adapters configure session-local models without receiving the upstream key', async t => {
  const dir = await temp(t), gateway = { baseUrl: 'http://127.0.0.1:33333', token: 'synthetic-local-token' };
  const codex = await engineConnection('codex', base, gateway, dir);
  assert.ok(codex.args.includes('model="test/model"'));
  assert.equal(codex.env.AGENT_ROOM_GATEWAY_KEY, gateway.token);
  const claude = await engineConnection('claude', base, gateway, dir, 'another-model');
  assert.equal(claude.env.ANTHROPIC_BASE_URL, gateway.baseUrl); assert.equal(claude.env.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'another-model');
  const opencode = await engineConnection('opencode', { ...base, protocol: 'responses' }, gateway, dir);
  const config = JSON.parse(opencode.env.OPENCODE_CONFIG_CONTENT);
  assert.equal(config.provider.agent_room.npm, '@ai-sdk/openai');
  const pi = await engineConnection('pi', base, gateway, dir);
  const extension = await fs.readFile(pi.args[1], 'utf8'); assert.ok(extension.includes('openai-responses')); assert.ok(extension.includes('test/model'));
  await assert.rejects(engineConnection('codex', { ...base, protocol: 'chat' }, gateway, dir), /不支持/);
  await assert.rejects(engineConnection('gemini', base, gateway, dir), /不支持/);
});
test('service launch passes the local bridge credential only to the selected child', async t => {
  const dir = await temp(t), calls = [];
  const service = new HcomService({ dataDir: dir, secretStorage: testEncryption(), run: async (args, timeout, env) => {
    calls.push({ args, env });
    if (args[0] === 'opencode') return JSON.stringify({ launched: 1 });
    if (args[0] === 'list') return '[]';
    if (args[0] === 'events') return '';
    throw new Error('Unexpected command');
  } }); t.after(() => service.close());
  const { id } = await service.saveConnection({ ...base, apiKey: 'UPSTREAM-SECRET-ONLY-IN-MEMORY' });
  await service.launch({ tool: 'opencode', directory: dir, connectionId: id, model: 'chosen-model' });
  const launch = calls.find(call => call.args[0] === 'opencode');
  assert.ok(!JSON.stringify(calls).includes('UPSTREAM-SECRET-ONLY-IN-MEMORY'));
  assert.equal(JSON.parse(launch.env.OPENCODE_CONFIG_CONTENT).model, 'agent_room/chosen-model');
  assert.equal(service.gateways.size, 1); assert.ok(!JSON.stringify(service.snapshot()).includes('UPSTREAM-SECRET-ONLY-IN-MEMORY'));
});
