const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { catalogModels } = require('../shared/model-catalog.cjs');
const { inspectModels, startGateway } = require('../lib/model-gateway.cjs');
const { HcomService } = require('../lib/hcom-service.cjs');
const base = { name: 'Magpie', protocol: 'multi', baseUrl: '', authMode: 'none', model: 'tool-model', contextWindow: 128000, maxTokens: 8192 };
async function listen(t, handler) {
  const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}/v1`;
}
const fixtureRows = [
  { id: 'tool-model', display_name: 'Tools', tool_call: true, capabilities: { supports_streaming: true }, reasoning: true, context_window: 200000, max_output_tokens: 16000, modalities: { input: ['text', 'image'] }, native_endpoints: ['/v1/messages'], apiKey: 'must-not-leak' },
  { id: 'no-tools', tool_call: false }, { id: 'unknown' }, { id: 'sync-only', streaming: false },
];
test('model metadata is allowlisted, unknown stays unknown, native endpoints do not prohibit translated APIs', () => {
  const models = catalogModels([null, 3, { id: 'bad\nmodel' }, ...fixtureRows, fixtureRows[0]], 'multi', 'manual');
  assert.equal(models.length, 5);
  assert.deepEqual(models[0].capabilities, { tools: true, streaming: true, images: true, reasoning: true, contextWindow: 200000, maxOutputTokens: 16000 });
  assert.ok(models[0].compatibility.every(item => item.status === 'compatible'));
  assert.ok(models[1].compatibility.every(item => item.status === 'incompatible'));
  assert.ok(models[2].compatibility.every(item => item.status === 'unknown'));
  assert.ok(models[3].compatibility.every(item => item.status === 'incompatible'));
  assert.equal(models[4].source, 'manual');
  assert.equal(models[4].capabilities.tools, null);
  assert.doesNotMatch(JSON.stringify(models), /must-not-leak|native_endpoints/);
  assert.equal(catalogModels(fixtureRows, 'chat')[0].compatibility.find(c => c.engineId === 'codex').status, 'incompatible');
});
test('models listing and saved catalog work through the public client without a model ID or exposed credentials', async t => {
  const requests = [];
  const baseUrl = await listen(t, (req, res) => { requests.push(req.url); res.end(JSON.stringify({ data: fixtureRows })); });
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-model-catalog-'));
  const service = new HcomService({ dataDir: dir, run: async args => args[0] === 'list' ? '[]' : '' });
  const { createChatApi } = await import('../lib/chat-api.mjs');
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const { createChatTransport } = await import('../renderer/client/transport.mjs');
  await service.refresh();
  const api = createChatApi(service), client = createAgentRoomClient(createChatTransport({ request: input => api.request(input), subscribe: fn => api.subscribe(fn) }));
  t.after(async () => { client.close(); api.close(); await service.close(); await fs.rm(dir, { recursive: true, force: true }); });
  await client.open();
  const profile = { ...base, baseUrl }, credentials = { apiKey: { action: 'keep' }, passphrase: { action: 'keep' } };
  const result = await client.query({ type: 'testConnection', profile: { ...profile, model: '' }, credentials });
  assert.equal(result.catalog.length, 4); assert.equal(result.ok, true);
  await assert.rejects(client.dispatch({ type: 'saveConnection', key: 'empty', profile: { ...profile, model: '' }, credentials }));
  const saved = await client.dispatch({ type: 'saveConnection', key: 'saved', profile, credentials });
  const catalog = await client.query({ type: 'modelCatalog', connectionId: saved.entityId, model: 'private/manual' });
  assert.equal(catalog.catalog.at(-1).source, 'manual');
  assert.doesNotMatch(JSON.stringify(catalog), /must-not-leak/);
  assert.deepEqual(requests, ['/v1/models', '/v1/models']);
  assert.equal((await client.query({ type: 'modelCatalog', connectionId: saved.entityId, model: ' tool-model ' })).catalog.filter(m => m.id === 'tool-model').length, 1);
  service.state.engines = [{ id: 'pi', installed: true, label: 'Pi' }];
  service.state.workspaces = [{ id: 'fixture', title: 'Fixture', directory: dir }];
  for (const key of ['blocked-one', 'blocked-again']) await assert.rejects(client.dispatch({ type: 'launchAgent', key, workspaceId: 'fixture', engineId: 'pi', connectionId: saved.entityId, model: ' no-tools ' }), { code: 'launch_failed', outcome: 'rejected' });
  assert.equal(service.gateways.size, 0, 'incompatible launches create no session gateway');
});
test('unavailable listing preserves manual model and reports failure without claiming inference success', async t => {
  const baseUrl = await listen(t, (req, res) => { res.writeHead(404); res.end('secret upstream body'); });
  const result = await inspectModels({ ...base, baseUrl }, {});
  assert.equal(result.ok, false); assert.deepEqual(result.models, []);
  assert.equal(result.catalog[0].source, 'manual');
  assert.ok(result.catalog[0].compatibility.every(c => c.status === 'unknown'));
  assert.doesNotMatch(result.message, /secret/);
});
test('Magpie-style upstream preserves tool streams for all three protocols and error status without retries', async t => {
  const streams = {
    responses: 'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call-1","name":"read","arguments":"{}"}}\n\nevent: response.completed\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
    messages: 'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"call-1","name":"read","input":{}}}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n',
    'chat/completions': 'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"read","arguments":"{}"}}]}}]}\n\ndata: [DONE]\n\n',
  };
  const seen = [];
  const baseUrl = await listen(t, async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    seen.push({ path: req.url, auth: req.headers.authorization, body });
    if (body === 'fail') { res.writeHead(429, { 'retry-after': '30' }); res.end('{"error":{"message":"limited"}}'); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream' }); const data = streams[req.url.slice(4)];
    res.write(data.slice(0, 35)); setImmediate(() => res.end(data.slice(35)));
  });
  const gateway = await startGateway({ ...base, baseUrl, authMode: 'bearer' }, { apiKey: 'upstream-only' }); t.after(() => gateway.close());
  const headers = { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' };
  for (const [route, stream] of Object.entries(streams)) {
    const response = await fetch(`${gateway.baseUrl}/v1/${route}`, { method: 'POST', headers, body: '{"model":"tool-model"}' });
    assert.equal(response.status, 200); assert.equal(await response.text(), stream);
  }
  const response = await fetch(`${gateway.baseUrl}/v1/responses`, { method: 'POST', headers, body: 'fail' });
  assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '30'); assert.match(await response.text(), /limited/);
  assert.equal(seen.length, 4); assert.ok(seen.every(req => req.auth === 'Bearer upstream-only'));
});
test('cancelling a model stream closes its upstream request', { timeout: 5000 }, async t => {
  let closed;
  const upstreamClosed = new Promise(resolve => { closed = resolve; });
  const baseUrl = await listen(t, (req, res) => { res.on('close', closed); res.writeHead(200, { 'content-type': 'text/event-stream' }); res.write('data: {"delta":"partial"}\n\n'); });
  const gateway = await startGateway({ ...base, baseUrl }, {}); t.after(() => gateway.close());
  const controller = new AbortController();
  const response = await fetch(`${gateway.baseUrl}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}` }, body: '{}', signal: controller.signal });
  await response.body.getReader().read(); controller.abort(); await upstreamClosed;
});
test('Mock model catalog uses the same compatibility rules and blocks known-incompatible launches', async t => {
  const { createMockTransport } = await import('../renderer/client/mock.mjs');
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const mock = createMockTransport({ manual: true }), client = createAgentRoomClient(mock.transport);
  t.after(() => { client.close(); mock.control.dispose(); }); await client.open();
  const saved = await client.dispatch({ type: 'saveConnection', key: 'save', profile: { ...base, baseUrl: 'http://127.0.0.1:3425/v1', model: 'example' }, credentials: { apiKey: { action: 'keep' }, passphrase: { action: 'keep' } } });
  const result = await client.query({ type: 'modelCatalog', connectionId: saved.entityId });
  assert.equal(result.catalog[0].compatibility[0].status, 'compatible');
  await assert.rejects(client.dispatch({ type: 'launchAgent', key: 'bad-launch', workspaceId: 'workspace-demo', engineId: 'pi', connectionId: saved.entityId, model: 'text-only' }), /工具调用/);
});
