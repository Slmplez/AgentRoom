// Real Magpie executable + controlled upstream. This does NOT prove external inference.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { inspectModels, startGateway } = require('../lib/model-gateway.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
const listen = server => new Promise(r => server.listen(0, '127.0.0.1', () => r(server.address().port)));
async function main() {
  const binary = process.env.MAGPIE_TEST_BINARY;
  if (!binary) throw Error('Set MAGPIE_TEST_BINARY to a verified official CLI executable.');
  await fs.access(binary);
  await fs.mkdir(path.resolve(__dirname, '../artifacts'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve(__dirname, '../artifacts/magpie-run-'));
  let processHandle, gateway, calls = [], cancelled = false;
  const fixture = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'fixture-model', object: 'model', owned_by: 'controlled-fixture' }] })); return; }
    let body = ''; for await (const part of req) body += part;
    const input = JSON.parse(body || '{}'); calls.push({ route: req.url, toolResult: input.messages?.some(m => m.role === 'tool') || false });
    if (input.messages?.some(m => m.content === 'fixture-error')) { res.writeHead(422, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'controlled upstream error', type: 'invalid_request_error' } })); return; }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture-model', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant' });
    if (input.messages?.some(m => m.content === 'fixture-cancel')) {
      const timer = setInterval(() => chunk({ content: 'tick ' }), 60);
      res.on('close', () => { clearInterval(timer); cancelled = true; }); return;
    }
    if (input.tools?.length && !input.messages?.some(m => m.role === 'tool')) chunk({ tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'echo', arguments: '{"value":"ok"}' } }] }, 'tool_calls');
    else { chunk({ content: 'fixture-ok' }); chunk({}, 'stop'); }
    res.end('data: [DONE]\n\n');
  });
  try {
    const fixturePort = await listen(fixture);
    const probe = http.createServer(); const port = await listen(probe); await new Promise(r => probe.close(r));
    const config = path.join(root, 'config'), cache = path.join(root, 'cache');
    await fs.mkdir(path.join(config, 'magpie'), { recursive: true });
    await fs.writeFile(path.join(config, 'magpie/providers.json'), JSON.stringify({ providers: [{ id: 'ar-fixture', name: 'AgentRoom controlled fixture', key: 'fixture-only', chat: `http://127.0.0.1:${fixturePort}/v1`, models: ['fixture-model'] }], noAutoGroups: true }));
    processHandle = spawn(path.resolve(binary), ['serve'], { windowsHide: true, env: { ...process.env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: cache, MAGPIE_NO_STATS: '1', MAGPIE_ADDR: `127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'] });
    // Retain no raw logs: startup output can contain local access tokens.
    processHandle.stdout.resume(); processHandle.stderr.resume();
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    for (let n = 0; ; n++) {
      if (processHandle.exitCode !== null) throw Error(`Magpie exited (${processHandle.exitCode}).`);
      try { const r = await fetch(baseUrl + '/models', { signal: AbortSignal.timeout(1500) }); if (r.ok) break; } catch {}
      if (n >= 60) throw Error('Magpie readiness timeout.'); await delay(250);
    }
    const profile = { id: 'real-magpie-check', protocol: 'multi', baseUrl, authMode: 'none', model: 'ar-fixture/fixture-model' };
    const listing = await inspectModels(profile, {});
    assert.ok(listing.ok && listing.models.includes(profile.model), 'Real Magpie model must be visible through AgentRoom discovery');
    gateway = await startGateway(profile, {});
    const request = async (messages, extra = {}, signal = AbortSignal.timeout(20000)) => fetch(gateway.baseUrl + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: profile.model, messages, stream: true, max_tokens: 64, ...extra }), signal });
    const text = await request([{ role: 'user', content: 'fixture-text' }]); assert.equal(text.status, 200); assert.match(text.headers.get('content-type'), /event-stream/); assert.match(await text.text(), /fixture-ok/);
    const tools = [{ type: 'function', function: { name: 'echo', description: 'Return the supplied value without side effects.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] } } }];
    const tool = await request([{ role: 'user', content: 'fixture-tool' }], { tools }); assert.equal(tool.status, 200); const toolText = await tool.text(); assert.match(toolText, /call_fixture/); assert.match(toolText, /tool_calls/);
    const continuation = await request([{ role: 'user', content: 'fixture-tool' }, { role: 'assistant', content: null, tool_calls: [{ id: 'call_fixture', type: 'function', function: { name: 'echo', arguments: '{"value":"ok"}' } }] }, { role: 'tool', tool_call_id: 'call_fixture', content: 'ok' }], { tools });
    assert.equal(continuation.status, 200); assert.match(await continuation.text(), /fixture-ok/); assert.ok(calls.some(c => c.toolResult));
    const failure = await request([{ role: 'user', content: 'fixture-error' }]); assert.equal(failure.status, 422); assert.match(await failure.text(), /controlled upstream error/);
    for (const [route, input, event] of [
      ['/v1/messages', { model: profile.model, messages: [{ role: 'user', content: 'fixture-text' }], stream: true, max_tokens: 64 }, /message_stop/],
      ['/v1/responses', { model: profile.model, input: 'fixture-text', stream: true, max_output_tokens: 64 }, /response.completed/],
    ]) {
      const converted = await fetch(gateway.baseUrl + route, { method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, body: JSON.stringify(input), signal: AbortSignal.timeout(20000) });
      assert.equal(converted.status, 200, route); const output = await converted.text(); assert.match(output, /fixture-ok/); assert.match(output, event);
    }
    const abort = new AbortController(); const stream = await request([{ role: 'user', content: 'fixture-cancel' }], {}, abort.signal); const reader = stream.body.getReader(); await reader.read(); abort.abort(); await reader.cancel().catch(() => {});
    for (let n = 0; !cancelled && n < 80; n++) await delay(50);
    assert.ok(cancelled, 'Cancellation must reach the controlled upstream through both gateways');
    const evidence = { kind: 'real-magpie-controlled-upstream', externalModelInference: 'not-tested', binarySha256: crypto.createHash('sha256').update(await fs.readFile(binary)).digest('hex'), model: profile.model, checks: ['AgentRoom models discovery', 'AgentRoom authenticated gateway -> real Magpie -> fixture', 'streaming text', 'tool call and tool result continuation', '422 error propagation', 'Anthropic streaming conversion', 'Responses streaming conversion', 'upstream cancellation'], upstreamCalls: calls.length };
    await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ ...evidence, evidencePath: path.join(root, 'evidence.json') }, null, 2));
  } finally {
    gateway?.close(); processHandle?.kill(); fixture.closeAllConnections(); fixture.close();
  }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
