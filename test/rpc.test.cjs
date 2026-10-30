const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once, EventEmitter } = require('node:events');
const path = require('node:path');
const { Lines, Pipe } = require('../lib/rpc/transport.cjs');
const { createEngine } = require('../lib/rpc/engines.cjs');
const { RpcRuntime } = require('../lib/rpc-runtime.cjs');
const fixture = path.join(__dirname, 'fixtures/rpc-agent.cjs');
const options = tool => ({ tool, directory: path.resolve(__dirname, '..'), env: { ...process.env, RPC_FIXTURE_TOOL: tool }, command: { command: process.execPath, args: [fixture] }, args: [], instructions: 'fixture instructions' });

test('RPC framing preserves fragmented UTF-8 and Unicode separators; rejects oversized records', () => {
  const records = [], parser = new Lines(s => records.push(JSON.parse(s)));
  const bytes = Buffer.from('{"text":"你好\u2028x\u2029z"}\r\n{"id":2}\n');
  for (const b of bytes) parser.push(Buffer.from([b]));
  assert.deepEqual(records, [{ text: '你好\u2028x\u2029z' }, { id: 2 }]);
  assert.throws(() => new Lines(() => {}, 3).push(Buffer.from('four')), /exceeds/);
});
for (const tool of ['codex', 'pi', 'claude', 'opencode']) {
  test(`${tool}: genuine pipes/HTTP, streamed completion, user-controlled approval, interrupt`, { timeout: 15000 }, async t => {
    const engine = createEngine(options(tool)); const failures = [];
    engine.on('failure', e => failures.push(e.message)); t.after(() => engine.close()); await engine.start();
    assert.equal(await engine.prompt('hello'), 'fixture reply 你好\u2028continued');
    const approval = once(engine, 'approval'); let completed = false;
    const reply = engine.prompt('approve operation').then(v => { completed = true; return v; });
    const [r] = await approval; assert.equal(completed, false);
    const delivered = await engine.respond(r.id, { allow: false });
      if (tool === 'opencode') assert.equal(delivered.delivery, 'confirmed');
    assert.match(await reply, /decline|false|deny|reject/);
    const pending = engine.prompt('wait');
    await new Promise(r => setTimeout(r, 40)); await engine.cancel(); assert.match(await pending, /interrupted/);
    if (['codex', 'pi'].includes(tool)) assert.equal(engine.lastOutcome, 'cancelled');
    await assert.rejects(engine.respond(r.id, { allow: true }), /失效/);
    assert.deepEqual(failures, []);
  });
}
test('Pipe correlates out-of-order responses and never retries timed out requests', async () => {
  const pipe = new Pipe({}); const records = []; pipe.write = async r => { records.push(r); };
  const a = pipe.request(id => ({ id })); const b = pipe.request(id => ({ id }));
  pipe.settle('2', 'second'); pipe.settle('1', 'first'); assert.deepEqual(await Promise.all([a, b]), ['first', 'second']);
  await assert.rejects(pipe.request(id => ({ id }), 'timeout', 10), /结果未知/); assert.equal(records.length, 3);
});
test('unexpected CLI exit rejects the active turn and does not restart or replay', async t => {
  const engine = createEngine(options('pi')); const failures = [];
  engine.on('failure', e => failures.push(e)); t.after(() => engine.close());
  await engine.start(); await assert.rejects(engine.prompt('crash-fixture'), /17/);
  assert.ok(failures.length); assert.equal(engine.pipe.exited, true);
});
test('uncertain dispatch stops its session before a queued task can run', async () => {
  let prompts = 0, closed = 0;
  const runtime = new RpcRuntime({ createEngine() {
    const e = new EventEmitter(); e.requests = new Map(); e.start = async () => {}; e.close = async () => { closed++; };
    e.prompt = async () => { prompts++; throw Object.assign(new Error('unknown outcome'), { uncertain: true }); }; return e;
  } });
  runtime.call = async method => method === 'rpcRegister' ? { instance_name: 'alpha' } : {};
  await runtime.launch({ tool: 'pi', directory: process.cwd(), args: [], env: {} });
  const s = runtime.session('alpha'); s.queue.push({ id: 1, text: 'first' }, { id: 2, text: 'second' });
  await runtime.drain(s); assert.equal(prompts, 1); assert.equal(s.alive, false); assert.ok(closed); assert.match(s.error, /unknown outcome/);
});
test('RPC supervisor queues per agent, preserves thread/reply IDs and never calls PTY launch', async () => {
  const calls = [], engines = [];
  const runtime = new RpcRuntime({ createEngine() {
    const e = new EventEmitter(); e.requests = new Map(); e.start = async () => {}; e.close = async () => {};
    e.prompt = text => new Promise(resolve => { e.input = text; e.complete = resolve; }); engines.push(e); return e;
  } });
  let inbox = [{ id: 1, text: 'one', thread: 'room-a', from: 'user' }, { id: 2, text: 'two', thread: 'room-b', from: 'peer' }];
  runtime.call = async (method, p) => {
    calls.push([method, p]); if (method === 'launch') throw new Error('PTY forbidden');
    if (method === 'rpcRegister') return { instance_name: 'alpha' };
    if (method === 'rpcInbox') return inbox;
    if (method === 'rpcAck') inbox = inbox.filter(m => m.id > p.id);
    return {};
  };
  await runtime.launch({ tool: 'pi', directory: process.cwd(), args: [], env: {} });
  await runtime.poll(); await new Promise(r => setTimeout(r, 5)); assert.match(engines[0].input, /room-a/);
  engines[0].complete('first'); await new Promise(r => setTimeout(r, 10)); assert.match(engines[0].input, /room-b/);
  engines[0].complete('second'); await new Promise(r => setTimeout(r, 10));
  const replies = calls.filter(c => c[0] === 'rpcReply').map(c => c[1]);
  assert.deepEqual(replies.map(p => [p.thread, p.replyTo, p.text]), [['room-a', '1', 'first'], ['room-b', '2', 'second']]);
  await runtime.poll(); assert.equal(calls.filter(c => c[0] === 'rpcAck').length, 2);
  await runtime.stop('alpha'); assert.equal(runtime.activeSessions, 0);
});
