const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, rm } = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { RpcRuntime } = require('../lib/rpc-runtime.cjs');
const { HcomService } = require('../lib/hcom-service.cjs');
const { createEngine } = require('../lib/rpc/engines.cjs');

for (const tool of ['codex', 'pi', 'claude', 'opencode']) test(`${tool} protocol cancellation reaches the public client without inventing confirmation`, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'run-client-'));
  const runtime = new RpcRuntime({ createEngine: options => createEngine({ ...options, env: { ...process.env, RPC_FIXTURE_TOOL: tool }, command: { command: process.execPath, args: [path.join(__dirname, 'fixtures/rpc-agent.cjs')] } }) });
  let inbox = [], event = 0;
  let releaseClaim;
  const claim = new Promise(resolve => { releaseClaim = resolve; });
  // Only the native message bus is replaced. Engine pipes/HTTP and both application modules are real.
  runtime.call = async (method, payload) => {
    if (method === 'rpcRegister') return { instance_name: 'alpha' };
    if (method === 'snapshot') return { agents: [{ name: 'alpha', tool, directory }], events: [] };
    if (method === 'send') { inbox.push({ id: ++event, from: 'user', ...payload }); return { event_id: event }; }
    if (method === 'rpcInbox') return inbox;
    if (method === 'rpcAck') { await claim; inbox = inbox.filter(m => m.id !== payload.id); }
    return {};
  };
  const service = new HcomService({ dataDir: directory, runtime });
  const { createChatApi } = await import('../lib/chat-api.mjs');
  const { createChatTransport } = await import('../renderer/client/transport.mjs');
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const api = createChatApi(service), client = createAgentRoomClient(createChatTransport(api));
  t.after(async () => { client.close(); api.close(); await service.close(); await rm(directory, { recursive: true, force: true }); });
  await runtime.launch({ tool, directory, env: {}, args: [] });
  await service.refresh(); await client.open();
  await client.dispatch({ type: 'send', key: 'wait', roomId: client.read().rooms[0].id, text: 'wait', mode: 'discussion', ownerAgentId: null, mentions: [] });
  await service.refresh();
  const claiming = client.read().runs[0];
  assert.equal(claiming.canCancel, false);
  await assert.rejects(client.dispatch({ type: 'cancelRun', key: 'early', runId: claiming.id }), { code: 'not_running' });
  releaseClaim();
  for (let i = 0; i < 100 && !client.read().runs.some(r => r.canCancel); i++) { await new Promise(r => setTimeout(r, 10)); await service.refresh(); }
  const run = client.read().runs.find(r => r.canCancel);
  assert.ok(run);
  await client.dispatch({ type: 'cancelRun', key: 'cancel', runId: run.id });
  for (let i = 0; i < 100 && ['running', 'cancel_requested'].includes(client.read().runs.find(r => r.id === run.id)?.status); i++) { await new Promise(r => setTimeout(r, 10)); await service.refresh(); }
  const final = client.read().runs.find(r => r.id === run.id);
  assert.equal(final.status, ['codex', 'pi'].includes(tool) ? 'cancelled' : 'unknown');
  assert.equal(client.read().messages.filter(m => m.runId === run.id).length, 1);
  assert.equal(final.canCancel, false);
});
