const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { HcomService, cleanAgent, normalizeMessages, resolveTargets, validateMessage, workspaceId } = require('../lib/hcom-service.cjs');

const directoryA = path.join(os.tmpdir(), 'ar-workspace-a');
const directoryB = path.join(os.tmpdir(), 'ar-workspace-b');
const raw = [
  { name: 'review-nora', base_name: 'nora', tool: 'codex', tag: 'review', directory: directoryA, status: 'listening' },
  { name: 'review-silo', base_name: 'silo', tool: 'opencode', tag: 'review', directory: directoryA, status: 'active' },
  { name: 'review-elsewhere', base_name: 'elsewhere', tool: 'codex', tag: 'review', directory: directoryB, status: 'listening' },
];
const agents = raw.map(cleanAgent);
const room = { id: 'review', allMembers: true, workspaceId: workspaceId(directoryA), thread: 'review-room' };
const event = (id, from, extra = {}) => ({ id, type: 'message', ts: '2026-10-29T12:00:00Z', data: { from, sender_kind: 'instance', text: 'hello', ...extra } });

test('tag expansion stays within the room and workspace', () => {
  assert.deepEqual(resolveTargets('@review 请审阅', room, agents), ['nora', 'silo']);
  assert.deepEqual(resolveTargets('@review- 请审阅', room, agents), ['nora', 'silo']);
  assert.deepEqual(resolveTargets('hello', room, agents), ['nora', 'silo']);
  assert.deepEqual(resolveTargets('@review-nora hello @nora', room, agents), ['nora']);
  assert.deepEqual(resolveTargets('@review', { ...room, allMembers: false, members: ['silo'] }, agents), ['silo']);
  assert.throws(() => resolveTargets('@elsewhere hello', room, agents), /没有找到/);
  assert.throws(() => resolveTargets('@does-not-exist hello', room, agents), /没有找到/);
});
test('messages without a thread inherit it through replies; cyclic replies terminate', () => {
  const messages = normalizeMessages([
    event(1, 'user', { sender_kind: 'external', thread: 'review-room' }),
    event(2, 'nora', { reply_to_local: 1 }), event(3, 'silo', { reply_to: '2' }),
    event(4, 'nora', { reply_to_local: 5 }), event(5, 'silo', { reply_to_local: 4 }),
    event(6, '[launcher]', { sender_kind: 'system' }),
  ], agents);
  assert.equal(messages.length, 5);
  assert.equal(messages[0].human, true);
  assert.deepEqual(messages.slice(0, 3).map(message => message.thread), Array(3).fill('review-room'));
  assert.equal(messages[3].thread, null);
  assert.equal(messages[1].senderName, 'Codex · Nora');
});
test('empty and oversized messages fail before process invocation', () => {
  assert.throws(() => validateMessage({ roomId: 'review', text: '   ' }), /先写/);
  assert.throws(() => validateMessage({ roomId: 'review', text: 'a'.repeat(16001) }), /太长/);
  assert.throws(() => validateMessage({ roomId: 'review', text: 'hello\0world' }), /字符/);
  assert.throws(() => validateMessage({ roomId: 3, text: 'hello' }), /格式/);
});
async function fixture(t, send) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-room-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const calls = [];
  const service = new HcomService({ dataDir: dir, run: async args => {
    calls.push(args);
    if (args[0] === 'list') return JSON.stringify(raw);
    if (args[0] === 'events') return '';
    if (args[0] === 'send') return send ? send(args) : JSON.stringify({ event_id: 7, delivered_to: ['nora'] });
    if (['opencode', 'pi', 'omp'].includes(args[0])) return JSON.stringify({ launched: 1, readiness: { status: 'ready' } });
    throw new Error(`Unexpected command ${args[0]}`);
  } });
  service.rooms.push(room);
  await service.refresh();
  return { service, calls, dir };
}
test('send uses explicit recipients and one literal message argument', async t => {
  const { service, calls } = await fixture(t);
  const text = '@review-nora `literal` $(not-a-command) "quotes"\nsecond line; & more';
  const result = await service.send({ roomId: room.id, text });
  const send = calls.find(args => args[0] === 'send');
  assert.deepEqual(result.targets, ['nora']);
  assert.equal(send.at(-1), text);
  assert.equal(send.at(-2), '--');
  assert.ok(send.includes('@nora'));
  assert.ok(!send.includes('@elsewhere'));
});
test('an uncertain send is never retried', async t => {
  const { service, calls } = await fixture(t, () => { throw new Error('timeout after possible commit'); });
  await assert.rejects(service.send({ roomId: room.id, text: '@nora hello' }), /结果未确认/);
  assert.equal(calls.filter(args => args[0] === 'send').length, 1);
});
test('room membership cannot include agents from another workspace', async t => {
  const { service } = await fixture(t);
  await assert.rejects(service.createRoom({ title: 'wrong', workspaceId: room.workspaceId, members: ['elsewhere'] }), /当前工作区/);
  const result = await service.createRoom({ title: 'Review team', workspaceId: room.workspaceId, members: ['nora', 'silo'] });
  assert.deepEqual(result.room.members, ['nora', 'silo']);
  assert.equal(result.room.workspaceId, room.workspaceId);
});
test('compatibility launches run headless with cwd and a literal validated tag', async t => {
  const { service, calls, dir } = await fixture(t);
  await service.launch({ tool: 'opencode', directory: dir, tag: 'frontend' });
  await service.launch({ tool: 'omp', directory: dir, tag: 'review_2' });
  assert.deepEqual(calls.find(args => args[0] === 'opencode'), ['opencode', '--headless', '--go', '--tag', 'frontend', '--dir', dir, '--json']);
  assert.ok(calls.filter(args => ['opencode', 'omp'].includes(args[0])).every(args => args.includes('--headless')));
  await assert.rejects(service.launch({ tool: 'powershell', directory: dir }), /受支持/);
  await assert.rejects(service.launch({ tool: 'pi', directory: dir, tag: 'x; do-bad-things' }), /Tag/);
});

test('native Add Agent bypasses the external terminal launcher', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-room-native-launch-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const runtime = new EventEmitter(), launches = [];
  runtime.snapshot = async () => ({ agents: [], events: [] });
  runtime.launch = async payload => {
    launches.push(payload);
    return { handles: [{ instance_name: 'local-test', tool: payload.tool, embedded: true }] };
  };
  const service = new HcomService({ dataDir: dir, runtime, run: async () => { throw new Error('External hcom must not be launched'); } });
  for (const tool of ['codex', 'claude', 'pi', 'opencode']) {
    const receipt = await service.launch({ tool, directory: dir, tag: 'room' });
    assert.equal(receipt.result.handles[0].embedded, true);
  }
  assert.deepEqual(launches.map(p => p.tool), ['codex', 'claude', 'pi', 'opencode']);
  assert.ok(launches.every(p => p.directory === dir && p.tag === 'room'));
  assert.ok(launches.every(p => !p.args.some(arg => ['--headless', '--go', '--tag', '--dir', '--json'].includes(arg))), 'hcom wrapper flags do not reach the agent CLI');
});
