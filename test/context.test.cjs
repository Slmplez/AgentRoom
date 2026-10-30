const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { ContextTelemetry, parseCodexContext, parsePiContext } = require('../lib/context-telemetry.cjs');
const { UsageCollector } = require('../lib/usage.cjs');
const { HcomService } = require('../lib/hcom-service.cjs');
const { render } = require('../renderer/context.js');

const metadata = (requestSequence, extra = {}) => ({ route: 'responses', requestSequence, status: 200, completed: true, usageComplete: true, ...extra });
const usage = input => ({ input, output: 20, cached: 60, cacheWrite: 0 });
const agents = ['a', 'b'].map(id => ({ id, name: id, tool: 'codex', directory: path.join(os.tmpdir(), id), sessionId: `session-${id}` }));
const event = (type, payload, timestamp = '2026-10-29T12:00:00Z') => JSON.stringify({ type, payload, timestamp });
const token = (input, window = 200000) => event('event_msg', { type: 'token_count', info: { model_context_window: window, last_token_usage: { input_tokens: input, output_tokens: 20, cached_input_tokens: 60, reasoning_output_tokens: 10 }, total_token_usage: { input_tokens: 999999 } } });
const lines = (...values) => `${values.join('\n')}\n`;

test('same-engine agents and workspaces keep separate scopes; new sessions never inherit old readings', () => {
  const tracker = new ContextTelemetry();
  const scopes = agents.map(() => tracker.createScope({ model: 'model-a', contextWindow: 128000 }));
  agents.forEach((a, i) => tracker.bind(scopes[i], [a.id], agents));
  tracker.record(scopes[0], metadata(1), usage(1000));
  tracker.record(scopes[1], metadata(1), usage(8000));
  assert.equal(tracker.snapshot(agents[0]).used, 1020);
  assert.equal(tracker.snapshot(agents[1]).used, 8020);
  assert.equal(tracker.snapshot({ ...agents[0], sessionId: 'replacement' }).used, null);
  assert.equal(tracker.snapshot({ ...agents[0], directory: 'other-workspace' }).used, null);
  assert.equal(new ContextTelemetry().snapshot(agents[0]).used, null);
});

test('latest request replaces prior values after compaction; cache is not counted twice; responses cannot regress out of order', () => {
  const tracker = new ContextTelemetry(), scope = tracker.createScope({ contextWindow: 128000 });
  tracker.bind(scope, ['a'], agents);
  tracker.record(scope, metadata(1), usage(9000));
  tracker.record(scope, metadata(3), usage(1000));
  tracker.record(scope, metadata(2), usage(5000));
  assert.equal(tracker.snapshot(agents[0]).used, 1020);
  assert.equal(tracker.snapshot(agents[0]).windowSource, 'configured');
  for (const route of ['responses/compact', 'messages/count_tokens']) tracker.record(scope, metadata(9, { route }), usage(1));
  assert.equal(tracker.snapshot(agents[0]).used, 1020);
});

test('missing usage, failures, incomplete streams and interruptions invalidate the latest observation', () => {
  for (const [extra, value] of [[{ interrupted: true }, usage(100)], [{ status: 500 }, usage(100)], [{ completed: false }, usage(100)], [{ usageComplete: false }, usage(100)], [{}, null]]) {
    const tracker = new ContextTelemetry(), scope = tracker.createScope({ contextWindow: 128000 });
    tracker.bind(scope, ['a'], agents);
    tracker.record(scope, metadata(1), usage(500));
    tracker.record(scope, metadata(2, extra), value);
    assert.equal(tracker.snapshot(agents[0]).used, null);
  }
});

test('collector requires a stream completion marker and detects errors even after partial usage', () => {
  const stream = new UsageCollector('text/event-stream');
  stream.push(Buffer.from('data: {"type":"message_start","message":{"usage":{"input_tokens":123}}}\n\n'));
  stream.finish(); assert.equal(stream.completed, false);
  const failed = new UsageCollector('text/event-stream');
  failed.push(Buffer.from('data: {"type":"error","error":{"type":"overloaded"}}\n\ndata: [DONE]\n\n'));
  failed.finish(); assert.equal(failed.completed, false);
  const json = new UsageCollector('application/json');
  json.push(Buffer.from('{"usage":{"input_tokens":0,"output_tokens":0}}')); json.finish();
  assert.equal(json.completed, true);
  assert.equal(json.hasInput && json.hasOutput, true);
  const missing = new UsageCollector('application/json');
  missing.push(Buffer.from('{"usage":{"output_tokens":10}}')); missing.finish();
  assert.equal(missing.hasInput, false); assert.equal(missing.hasOutput, true);
});

test('Codex uses last usage, reported window and model; cumulative/cache/reasoning fields are not added', () => {
  const result = parseCodexContext(lines(event('turn_context', { model: 'actual' }), token(500)));
  assert.equal(result.used, 520); assert.equal(result.window, 200000);
  assert.equal(result.windowSource, 'reported'); assert.equal(result.model, 'actual');
  const compacted = event('compacted', {});
  assert.equal(parseCodexContext(lines(token(8000), compacted)).used, null);
  assert.equal(parseCodexContext(lines(token(8000), compacted, token(1000))).used, 1020);
  assert.equal(parseCodexContext(lines(event('turn_context', { model: 'before' }), token(8000), event('turn_context', { model: 'after' }))).used, null);
  assert.equal(parseCodexContext(lines(token(1000)) + token(9999).slice(0, -3)).used, 1020);
  assert.equal(parseCodexContext(lines(event('event_msg', { type: 'token_count', info: { total_token_usage: { input_tokens: 9999 } } }))).used, null);
});

test('transcript read requires the bound session; service snapshots expose metrics without transcript content or paths', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-context-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'rollout.jsonl');
  await fs.writeFile(file, lines(event('session_meta', { id: 'session-a' }), event('response_item', { text: 'PRIVATE-CONTENT' }), token(500)));
  const tracker = new ContextTelemetry();
  assert.equal((await tracker.observe(agents[0], file)).used, 520);
  assert.equal((await tracker.observe({ ...agents[0], sessionId: 'wrong' }, file)).used, null);
  const service = new HcomService({ dataDir: directory, run: async args => args[0] === 'list' ? JSON.stringify([{ name: 'a', directory, tool: 'codex', session_id: 'session-a', transcript_path: file }]) : '' });
  const state = await service.refresh();
  assert.equal(state.agents[0].context.used, 520);
  assert.ok(!JSON.stringify(state).includes('PRIVATE-CONTENT'));
  assert.ok(!JSON.stringify(state).includes('rollout.jsonl'));
  await fs.appendFile(file, lines(event('compacted', {}), token(100)));
  assert.equal((await service.refresh()).agents[0].context.used, 120);
});

test('context UI distinguishes unknown, configured limit, overflow and escaped data', () => {
  assert.ok(render().includes('未知')); assert.ok(!render().includes('≈0'));
  const html = render({ used: 1500, window: 1000, windowSource: 'configured', reason: '"><script>' }, true);
  assert.ok(html.includes('150%')); assert.ok(html.includes('配置上限')); assert.ok(html.includes('stroke-dasharray="100 100"'));
  assert.ok(!html.includes('<script>')); assert.ok(html.includes('&lt;script&gt;'));
  assert.ok(render().includes('context-ring--unknown'));
  assert.ok(render({ used: 0, window: 1000 }).includes('context-ring--known'));
  assert.ok(render({ used: 500 }).includes('context-ring--unbounded'));
  assert.ok(!render({ used: 500 }).includes('stroke-dasharray'));
  assert.ok(render({ used: 0, window: 1000 }).includes('占 0%'));
});

const piEntry = (type, id, parentId, extra = {}) => JSON.stringify({ type, id, parentId, timestamp: '2026-10-29T12:00:00Z', ...extra });
const piMessage = (id, parentId, usage, extra = {}) => piEntry('message', id, parentId, { message: { role: 'assistant', model: 'pi-model', stopReason: 'stop', usage, ...extra } });

test('Pi transcript counts cached input once, follows the latest branch and ignores incomplete records', () => {
  const start = piEntry('model_change', 'm', null, { modelId: 'pi-model' });
  const a = piMessage('a', 'm', { input: 331, output: 1217, cacheRead: 129664, cacheWrite: 0, totalTokens: 131212, reasoning: 931 });
  const b = piMessage('b', 'm', { input: 100, output: 20, cacheRead: 800, cacheWrite: 10 });
  assert.equal(parsePiContext(lines(start, a)).used, 131212);
  assert.equal(parsePiContext(lines(start, a, b)).used, 930);
  assert.equal(parsePiContext(lines(start, a, b) + piMessage('c', 'b', { totalTokens: 9999 }).slice(0, -5)).used, 930);
  // The current branch has no valid usage, even though the abandoned branch did.
  const error = piMessage('err', 'm', { totalTokens: 0 }, { stopReason: 'error' });
  assert.equal(parsePiContext(lines(start, a, error)).used, null);
});

test('Pi invalidates after compaction/model changes; errors and zero usage cannot fabricate a reading', () => {
  const good = piMessage('a', null, { totalTokens: 8000 });
  assert.equal(parsePiContext(lines(good, piEntry('compaction', 'c', 'a'))).used, null);
  assert.equal(parsePiContext(lines(good, piEntry('model_change', 'm', 'a', { modelId: 'new-model' }))).used, null);
  assert.equal(parsePiContext(lines(good, piMessage('b', 'a', { totalTokens: 0 }, { model: 'new-model', stopReason: 'error' }))).used, null);
  for (const usage of [{ totalTokens: 0 }, { input: -1 }, {}, { input: Number.MAX_SAFE_INTEGER, output: 1 }]) {
    assert.equal(parsePiContext(lines(piMessage('a', null, usage))).used, null);
  }
  // Failed retries do not destroy the previous valid observation in the same context.
  assert.equal(parsePiContext(lines(good, piMessage('err', 'a', { totalTokens: 0 }, { stopReason: 'error' }))).used, 8000);
});

test('Pi transcript fallback is session/workspace bound even after a cache hit', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-pi-transcript-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'pi.jsonl'), agent = { ...agents[0], tool: 'pi', directory };
  await fs.writeFile(file, lines(JSON.stringify({ type: 'session', id: agent.sessionId, cwd: directory }), piMessage('a', null, { totalTokens: 1234 })));
  const tracker = new ContextTelemetry({ dataDir: directory });
  assert.equal((await tracker.observe(agent, file)).used, 1234);
  assert.equal((await tracker.observe({ ...agent, sessionId: 'other' }, file)).used, null);
  assert.equal((await tracker.observe({ ...agent, directory: path.join(directory, 'other') }, file)).used, null);
});

test('Pi runtime extension reports without a gateway, isolates sessions and clears stale model/compaction values', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-pi-runtime-'));
  const previousEnv = process.env.AGENT_ROOM_CONTEXT_DIR;
  t.after(async () => {
    if (previousEnv === undefined) delete process.env.AGENT_ROOM_CONTEXT_DIR; else process.env.AGENT_ROOM_CONTEXT_DIR = previousEnv;
    await fs.rm(directory, { recursive: true, force: true });
  });
  const tracker = new ContextTelemetry({ dataDir: directory }), telemetry = await tracker.piExtension();
  process.env.AGENT_ROOM_CONTEXT_DIR = telemetry.env.AGENT_ROOM_CONTEXT_DIR;
  const { default: extension } = await import(require('node:url').pathToFileURL(telemetry.args[1]).href);
  const handlers = new Map(); extension({ on: (name, callback) => handlers.set(name, callback) });
  const agent = { ...agents[0], tool: 'pi', directory };
  let usage = { tokens: 9000, contextWindow: 128000 };
  const ctx = { cwd: directory, model: { id: 'pi-model', contextWindow: 128000 }, sessionManager: { getSessionId: () => agent.sessionId }, getContextUsage: () => usage };
  await handlers.get('session_start')({ type: 'session_start' }, ctx);
  let observed = await tracker.observe(agent);
  assert.equal(observed.used, 9000); assert.equal(observed.window, 128000); assert.equal(observed.source, 'pi-runtime');
  assert.equal((await tracker.observe({ ...agent, sessionId: 'other' })).used, null);
  assert.equal((await tracker.observe({ ...agent, directory: path.join(directory, 'other') })).used, null);
  ctx.model = { id: 'new-model', contextWindow: 64000 };
  ctx.sessionManager.getBranch = () => [{ type: 'message', message: { role: 'assistant', model: 'pi-model', stopReason: 'stop', usage: { totalTokens: 9000 } } }];
  await handlers.get('session_start')({ type: 'session_start', reason: 'resume' }, ctx);
  assert.equal((await tracker.observe(agent)).used, null, 'resuming with a new model must not relabel its old usage');
  await handlers.get('model_select')({ type: 'model_select' }, ctx);
  assert.equal((await tracker.observe(agent)).used, null);
  // message_end runs before Pi persists the assistant: do not publish its old usage.
  await handlers.get('message_end')({ type: 'message_end', message: { role: 'assistant', model: 'new-model', stopReason: 'stop' } }, ctx);
  assert.equal((await tracker.observe(agent)).used, null);
  usage = { tokens: 500, contextWindow: 64000 };
  await handlers.get('turn_end')({ type: 'turn_end' }, ctx);
  assert.equal((await tracker.observe(agent)).used, 500);
  usage = { tokens: null, contextWindow: 64000 };
  await handlers.get('session_compact')({ type: 'session_compact' }, ctx);
  assert.equal((await tracker.observe(agent)).used, null);
  usage = { tokens: 0, contextWindow: 64000 };
  await handlers.get('message_end')({ type: 'message_end', message: { role: 'assistant', model: 'new-model', stopReason: 'error' } }, ctx);
  await handlers.get('agent_end')({ type: 'agent_end' }, ctx);
  assert.equal((await tracker.observe(agent)).used, null);
  const files = await fs.readdir(telemetry.env.AGENT_ROOM_CONTEXT_DIR);
  assert.deepEqual(files, [`${agent.sessionId}.json`]);
});

test('Pi default-config launch receives its telemetry extension without requesting a model', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-pi-launch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let launchArgs, launchEnv;
  const service = new HcomService({ dataDir: directory, run: async (args, timeout, env) => {
    if (args[0] === 'list') return '[]';
    if (args[0] === 'events') return '';
    launchArgs = args; launchEnv = env; return '{"names":[],"launched":1}';
  } });
  t.after(() => service.close());
  await service.launch({ tool: 'pi', directory });
  assert.equal(service.gateways.size, 0);
  assert.ok(launchArgs.includes('--extension'));
  assert.ok((await fs.readFile(launchArgs.at(-1), 'utf8')).includes('getContextUsage'));
  assert.equal(launchEnv.AGENT_ROOM_CONTEXT_DIR, path.join(directory, 'context'));
});

test('service launch binds two real loopback gateways to the returned agent names', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-context-launch-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: [{ id: 'test-model' }] })); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ model: 'test-model', usage: { input_tokens: JSON.parse(body).input, output_tokens: 20 } }));
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const roster = [];
  const service = new HcomService({ dataDir: directory, run: async args => {
    if (args[0] === 'list') return JSON.stringify(roster);
    if (args[0] === 'events') return '';
    const name = `agent-${roster.length}`;
    roster.push({ name, directory, tool: 'codex', session_id: `session-${name}` });
    return JSON.stringify({ names: [name], launched: 1 });
  } });
  t.after(() => service.close());
  service.connections.get = () => ({ profile: { id: 'test', protocol: 'responses', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, authMode: 'none', model: 'test-model', contextWindow: 100000 }, secrets: {} });
  await service.launch({ tool: 'codex', directory, connectionId: 'test' });
  await service.launch({ tool: 'codex', directory, connectionId: 'test' });
  const gateways = [...service.gateways];
  for (const [i, gateway] of gateways.entries()) {
    const res = await fetch(`${gateway.baseUrl}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}` }, body: JSON.stringify({ input: (i + 1) * 1000 }) });
    await res.text();
  }
  const state = await service.refresh();
  assert.deepEqual(state.agents.map(a => a.context.used), [1020, 2020]);
  assert.deepEqual(state.agents.map(a => a.context.window), [100000, 100000]);
  await service.usage.pending;
});
