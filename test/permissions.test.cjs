const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { ApprovalBroker } = require('../lib/rpc/approvals.cjs');
const { RpcRuntime } = require('../lib/rpc-runtime.cjs');

test('approval tokens isolate reused wire IDs, expiry cannot resurrect a request', async () => {
  const broker = new ApprovalBroker();
  const requests = new Map([['1', { kind: 'permission', data: { command: 'first' } }]]);
  broker.sync(requests); const first = broker.list()[0].id;
  broker.expire(); broker.sync(requests); assert.equal(broker.list().length, 0);
  requests.set('1', { kind: 'permission', data: { command: 'second' } });
  broker.sync(requests); assert.notEqual(broker.list()[0].id, first);
  await assert.rejects(broker.respond(first, { allow: true }, { requests }), /失效/);
});

test('approval requires explicit single-use decision and rejects duplicate in-flight submissions', async () => {
  const broker = new ApprovalBroker(), requests = new Map([['1', { kind: 'permission', data: {} }]]);
  broker.sync(requests); const id = broker.list()[0].id;
  let writes = 0, finish;
  const engine = { requests, respond: async () => { writes++; await new Promise(resolve => { finish = resolve; }); requests.clear(); broker.sync(requests); } };
  await assert.rejects(broker.respond(id, { allow: 'false' }, engine), /格式错误/);
  await assert.rejects(broker.respond(id, { allow: true, scope: 'always' }, engine), /单次/);
  const submitted = broker.respond(id, { allow: false }, engine);
  await assert.rejects(broker.respond(id, { allow: true }, engine), /重复提交/);
  finish(); await submitted;
  assert.equal(writes, 1); assert.equal(broker.history[0].status, 'denied');
  await assert.rejects(broker.respond(id, { allow: true }, engine), /失效/);
});

test('delivery errors mark approval unknown instead of inviting a silent retry', async () => {
  const broker = new ApprovalBroker(), requests = new Map([['1', { kind: 'permission', data: {} }]]);
  broker.sync(requests); const id = broker.list()[0].id;
  await assert.rejects(broker.respond(id, { allow: true }, { requests, respond: async () => { throw new Error('write failed'); } }), { uncertain: true });
  broker.sync(requests); assert.equal(broker.list().length, 0); assert.equal(broker.history[0].status, 'unknown');
});

test('runtime retains correlated tools after a turn and invalidates approvals on cancel', async () => {
  let engine;
  const runtime = new RpcRuntime({ createEngine() {
    engine = new EventEmitter(); engine.requests = new Map(); engine.start = async () => {}; engine.close = async () => {}; engine.cancel = async () => {};
    engine.prompt = async () => {
      engine.emit('activity', { id: 't1', kind: 'Bash', detail: 'echo hello' });
      engine.emit('activity', { id: 't1', kind: 'tool', status: 'completed', output: 'hello' });
      return 'done';
    };
    return engine;
  } });
  runtime.call = async method => method === 'rpcRegister' ? { instance_name: 'alpha' } : {};
  await runtime.launch({ tool: 'pi', directory: 'workspace' });
  const session = runtime.session('alpha'); session.queue.push({ id: 1, thread: 'room-a', text: 'go' });
  await runtime.drain(session);
  const view = runtime.inspect('alpha');
  assert.equal(view.tools.length, 1);
  assert.deepEqual([view.tools[0].kind, view.tools[0].detail, view.tools[0].output, view.tools[0].thread, view.tools[0].turnId], ['Bash', 'echo hello', 'hello', 'room-a', '1']);
  session.current = { id: 2, thread: 'room-b' };
  engine.requests.set('2', { kind: 'permission', data: {} }); engine.emit('approval');
  const request = runtime.inspect('alpha').approvals[0];
  assert.equal(request.thread, 'room-b'); assert.equal(request.directory, 'workspace');
  await runtime.cancel('alpha');
  await assert.rejects(runtime.respond('alpha', request.id, { allow: true }), /失效/);
  engine.emit('requests-cleared'); assert.equal(runtime.inspect('alpha').approvals.length, 0);
  await runtime.stop('alpha');
});
