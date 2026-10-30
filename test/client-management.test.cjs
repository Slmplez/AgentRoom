const { test } = require('node:test');
const assert = require('node:assert/strict');
async function fixture(t) {
  const { createMockTransport } = await import('../renderer/client/mock.mjs');
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const mock = createMockTransport({ manual: true }), client = createAgentRoomClient(mock.transport);
  t.after(() => { client.close(); mock.control.dispose(); }); await client.open(); return { client, control: mock.control };
}
test('Mock developer can manage members, connections and capability assignments through the real client', async t => {
  const { client } = await fixture(t);
  const workspace = await client.dispatch({ type: 'createWorkspace', key: 'workspace', title: '新工作区', directory: 'mock://project' });
  const agent = await client.dispatch({ type: 'launchAgent', key: 'launch', workspaceId: workspace.entityId, engineId: 'pi' });
  const room = await client.dispatch({ type: 'createRoom', key: 'room', workspaceId: workspace.entityId, title: '开发', memberIds: [agent.entityId] });
  await assert.rejects(client.dispatch({ type: 'setRoomMembers', key: 'bad', roomId: room.entityId, memberIds: ['alpha'] }), { code: 'invalid_members' });
  const server = await client.dispatch({ type: 'saveCapabilityServer', key: 'server', server: { name: '示例', transport: 'stdio', command: 'example', args: [], enabled: true, isolation: 'session', env: { SECRET: 'never-public' } } });
  const skill = await client.dispatch({ type: 'importSkill', key: 'skill', directory: 'mock://skill' });
  await client.dispatch({ type: 'bindCapabilities', key: 'binding', workspaceId: workspace.entityId, serverIds: [server.entityId], skillIds: [skill.entityId] });
  const library = await client.query({ type: 'capabilities' });
  assert.doesNotMatch(JSON.stringify(library), /never-public/);
  assert.deepEqual(library.bindings[0].serverIds, [server.entityId]);
  await client.dispatch({ type: 'stopAgent', key: 'stop', agentId: agent.entityId });
  assert.equal(client.read().agents.find(a => a.id === agent.entityId).status, 'inactive');
  await client.dispatch({ type: 'removeAgent', key: 'remove', agentId: agent.entityId });
  assert.equal(client.read().agents.some(a => a.id === agent.entityId), false);
  assert.deepEqual(client.read().rooms.find(r => r.id === room.entityId).memberIds, []);
});
test('telemetry keeps unknown context distinct from zero and watchers release in-flight results', async t => {
  const { client, control } = await fixture(t);
  assert.equal((await client.query({ type: 'contexts' })).agents[0].context.used, null);
  control.telemetry();
  const context = (await client.query({ type: 'contexts' })).agents[0].context;
  assert.equal(context.used, 4096); assert.equal(context.confidence, 'estimated');
  const usage = await client.query({ type: 'usage' });
  assert.equal(usage.totals.total, 1200); assert.equal(usage.totals.unknown, 1);
  const updates = []; const dispose = client.watch({ type: 'usage' }, value => updates.push(value));
  dispose(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(updates.map(v => v.status), ['loading']);
  control.failNext('contexts'); await assert.rejects(client.query({ type: 'contexts' }), { code: 'simulated_failure' });
});

test('an unknown management operation cannot be bypassed with a fresh request key', async t => {
  const { createMockTransport } = await import('../renderer/client/mock.mjs');
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const mock = createMockTransport({ manual: true }); let calls = 0;
  const client = createAgentRoomClient({ ...mock.transport, command: async () => { calls++; throw Object.assign(new Error('response lost'), { outcome: 'unknown' }); } });
  t.after(() => { client.close(); mock.control.dispose(); }); await client.open();
  const command = { type: 'launchAgent', workspaceId: 'workspace-demo', engineId: 'pi' };
  await assert.rejects(client.dispatch({ ...command, key: 'first' }), { outcome: 'unknown' });
  await assert.rejects(client.dispatch({ ...command, key: 'replacement' }), { code: 'outcome_unknown' });
  assert.equal(calls, 1);
});

test('stopping a Mock Agent preserves cancelled runs and private history', async t => {
  const { client, control } = await fixture(t);
  await client.dispatch({ type: 'send', key: 'start', roomId: 'dm:alpha', text: 'hello', mode: 'discussion', ownerAgentId: null, mentions: [] });
  await client.dispatch({ type: 'stopAgent', key: 'stop', agentId: 'alpha' });
  control.advance(); control.advance();
  assert.equal(client.read().runs[0].status, 'cancelled');
  await client.dispatch({ type: 'removeAgent', key: 'remove', agentId: 'alpha' });
  assert.ok(client.read().rooms.some(r => r.id === 'dm:alpha'));
  assert.ok(client.read().messages.some(m => m.roomId === 'dm:alpha'));
});

test('Mock launch uncertainty and large tool details are deterministic public scenarios', async t => {
  const { client, control } = await fixture(t);
  control.launchUnknown();
  const command = { type: 'launchAgent', engineId: 'pi', workspaceId: 'workspace-demo' };
  await assert.rejects(client.dispatch({ ...command, key: 'lost' }), { code: 'launch_unknown', outcome: 'unknown' });
  await assert.rejects(client.dispatch({ ...command, key: 'new' }), { code: 'outcome_unknown' });
  assert.equal(client.read().agents.length, 4);
  control.largeDiff();
  const tool = client.read().messages.at(-1).tools[1];
  assert.deepEqual(tool.patches, []);
  assert.ok((await client.query({ type: 'toolDetails', ref: tool.detailRef })).patches[0].split('\n').length > 800);
});
