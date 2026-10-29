const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { UsageCollector, UsageLedger, aggregateUsage } = require('../lib/usage.cjs');
const { startGateway } = require('../lib/model-gateway.cjs');

function feed(collector, text) { const bytes = Buffer.from(text); for (let offset = 0; offset < bytes.length; offset += 7) collector.push(bytes.subarray(offset, offset + 7)); return collector.finish(); }
test('Responses SSE usage counts a final response once even when repeated and split across byte chunks', () => {
  const c = new UsageCollector('text/event-stream');
  const event = JSON.stringify({ type: 'response.completed', response: { model: 'actual-model', usage: { input_tokens: 100, output_tokens: 30, input_tokens_details: { cached_tokens: 60 } } } });
  assert.deepEqual(feed(c, `data: {"delta":"你好"}\n\ndata: ${event}\n\ndata: ${event}\n\ndata: [DONE]\n\n`), { input: 100, output: 30, cached: 60, cacheWrite: 0 });
  assert.equal(c.model, 'actual-model');
});
test('Anthropic partial usage combines cached input with final output without adding cumulative deltas', () => {
  const c = new UsageCollector('text/event-stream');
  const events = [
    { type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 50, output_tokens: 0, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 } } },
    { type: 'message_delta', usage: { output_tokens: 10 } }, { type: 'message_delta', usage: { output_tokens: 25 } },
  ];
  assert.deepEqual(feed(c, events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('')), { input: 170, output: 25, cached: 100, cacheWrite: 20 });
});
test('Chat Completions JSON usage works and absent/oversized usage remains unknown', () => {
  assert.deepEqual(feed(new UsageCollector('application/json'), JSON.stringify({ usage: { prompt_tokens: 90, completion_tokens: 14, prompt_tokens_details: { cached_tokens: 30 } } })), { input: 90, output: 14, cached: 30, cacheWrite: 0 });
  assert.equal(feed(new UsageCollector('text/event-stream'), 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n'), null);
  const c = new UsageCollector('application/json'); c.push(Buffer.alloc(3 * 1024 * 1024, 'a')); assert.equal(c.finish(), null);
  const streaming = new UsageCollector('text/event-stream'); streaming.push(Buffer.alloc(2 * 1024 * 1024, 'a'));
  assert.equal(feed(streaming, '\ndata: {"usage":{"input_tokens":1,"output_tokens":2}}\n\n').output, 2);
});
test('ledger persists only allowlisted metrics, reloads and tolerates a damaged trailing line', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-usage-')); t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const ledger = new UsageLedger(dir);
  await ledger.record({ engine: 'pi', model: 'custom', profileId: 'profile', status: 200, prompt: 'PRIVATE-PROMPT', apiKey: 'PRIVATE-KEY' }, { input: 100, output: 20, cached: 40 });
  await ledger.record({ engine: 'pi', model: 'custom', status: 502, interrupted: true }, null);
  const file = await fs.readFile(ledger.file, 'utf8'); assert.ok(!file.includes('PRIVATE-'));
  await fs.appendFile(ledger.file, '{damaged-tail');
  const loaded = new UsageLedger(dir); await loaded.load();
  assert.equal(loaded.events.length, 2); assert.ok(loaded.error);
  const totals = loaded.snapshot().totals;
  assert.deepEqual(totals, { requests: 2, known: 1, unknown: 1, errors: 1, input: 100, output: 20, cached: 40, cacheWrite: 0, total: 120 });
  await loaded.record({ engine: 'codex', model: 'after-damaged-tail', status: 200 }, { input: 1, output: 2 });
  const again = new UsageLedger(dir); await again.load(); assert.equal(again.events.length, 3);
});
test('heatmap has exactly 364 local calendar days and excludes records outside its period', () => {
  const stats = aggregateUsage([
    { timestamp: '2020-01-01T12:00:00', engine: 'codex', model: 'old', status: 200, usage: { input: 999, output: 999 } },
    { timestamp: '2026-10-29T12:00:00', engine: 'codex', model: 'new', status: 200, usage: { input: 7, output: 3 } },
    { timestamp: '2026-10-29T13:00:00', engine: 'pi', model: 'unknown', status: 200, usage: null },
  ], new Date(2026, 9, 29));
  assert.equal(stats.days.length, 364); assert.equal(stats.days.at(-1).date, '2026-10-29');
  assert.equal(stats.totals.total, 10); assert.equal(stats.days.at(-1).requests, 2); assert.equal(stats.days.at(-1).unknown, 1);
  assert.equal(stats.models.length, 2);
});
test('gateway emits one real usage record after streaming without altering SSE output', async t => {
  const events = [], payload = 'data: {"type":"response.completed","response":{"model":"served-model","usage":{"input_tokens":123,"output_tokens":45}}}\n\ndata: [DONE]\n\n';
  const upstream = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(payload); });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve)); t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const gateway = await startGateway({ protocol: 'responses', baseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, model: 'alias', id: 'profile', authMode: 'none' }, {}, { engine: 'codex', onUsage: (metadata, usage) => events.push({ metadata, usage }) }); t.after(() => gateway.close());
  const response = await fetch(`${gateway.baseUrl}/v1/responses`, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}` }, body: '{}' });
  assert.equal(await response.text(), payload); assert.equal(events.length, 1); assert.equal(events[0].metadata.model, 'served-model');
  assert.deepEqual(events[0].usage, { input: 123, output: 45, cached: 0, cacheWrite: 0 });
});
