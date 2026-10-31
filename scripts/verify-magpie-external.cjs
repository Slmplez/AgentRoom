// Explicit opt-in: three billable, bounded DeepSeek requests using an existing env key.
// A loopback relay injects the key in memory; no credentials enter Magpie's files.
const http = require('node:http'), https = require('node:https');
const fs = require('node:fs/promises'), path = require('node:path'), crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { inspectModels, startGateway } = require('../lib/model-gateway.cjs');
const delay = ms => new Promise(r => setTimeout(r, ms));
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
async function main() {
  if (!process.argv.includes('--allow-billable')) throw Error('Requires --allow-billable (at most three inference requests).');
  const binary = process.env.MAGPIE_TEST_BINARY, key = process.env.DEEPSEEK_API_KEY;
  if (!binary || !key) throw Error('Requires MAGPIE_TEST_BINARY and existing DEEPSEEK_API_KEY.');
  await fs.access(binary);
  await fs.mkdir(path.resolve(__dirname, '../artifacts'), { recursive: true });
  const root = await fs.mkdtemp(path.resolve(__dirname, '../artifacts/magpie-external-'));
  let child, gateway, inferenceRequests = 0; const upstreams = new Set();
  const relay = http.createServer((req, res) => {
    const pathname = req.url?.replace(/^\/v1/, '');
    if (!['/models', '/chat/completions'].includes(pathname)) { res.writeHead(404); res.end(); return; }
    if (pathname === '/chat/completions' && ++inferenceRequests > 3) { res.writeHead(429); res.end(); return; }
    const upstream = https.request('https://api.deepseek.com' + pathname, { method: req.method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' } }, response => {
      res.writeHead(response.statusCode, { 'content-type': response.headers['content-type'] || 'application/json' }); response.pipe(res);
    });
    upstreams.add(upstream); upstream.on('close', () => upstreams.delete(upstream));
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    upstream.setTimeout(60000, () => upstream.destroy());
    res.on('close', () => { if (!res.writableFinished) upstream.destroy(); }); req.pipe(upstream);
  });
  try {
    const relayPort = await listen(relay); const probe = http.createServer(); const port = await listen(probe); await new Promise(r => probe.close(r));
    const config = path.join(root, 'config'); await fs.mkdir(path.join(config, 'magpie'), { recursive: true });
    await fs.writeFile(path.join(config, 'magpie/providers.json'), JSON.stringify({ providers: [{ id: 'ar-deepseek', name: 'DeepSeek verification relay', chat: `http://127.0.0.1:${relayPort}/v1`, key: 'local-relay-no-credential', models: ['deepseek-flash'] }], noAutoGroups: true }));
    // Do not pass the provider key to the child; only the relay needs it.
    const env = { ...process.env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: path.join(root, 'cache'), MAGPIE_NO_STATS: '1', MAGPIE_ADDR: `127.0.0.1:${port}` };
    delete env.DEEPSEEK_API_KEY; delete env.KIMI_API_KEY;
    child = spawn(path.resolve(binary), ['serve'], { windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'] }); child.stdout.resume(); child.stderr.resume();
    const profile = { id: 'real-magpie-external', protocol: 'multi', baseUrl: `http://127.0.0.1:${port}/v1`, authMode: 'none', model: 'ar-deepseek/deepseek-flash' };
    for (let n = 0; ; n++) {
      if (child.exitCode !== null) throw Error('Magpie exited before readiness.');
      try { const response = await fetch(profile.baseUrl + '/models', { signal: AbortSignal.timeout(1500) }); if (response.ok) break; } catch {}
      if (n > 60) throw Error('Magpie readiness timed out.'); await delay(250);
    }
    const listed = await inspectModels(profile, {}); assert.ok(listed.ok && listed.models.includes(profile.model));
    gateway = await startGateway(profile, {});
    const usage = [];
    async function complete(messages, extra = {}) {
      const response = await fetch(gateway.baseUrl + '/v1/chat/completions', { method: 'POST', headers: { authorization: `Bearer ${gateway.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: profile.model, messages, stream: true, stream_options: { include_usage: true }, thinking: { type: 'disabled' }, max_tokens: 64, ...extra }), signal: AbortSignal.timeout(60000) });
      assert.equal(response.status, 200, 'External inference status'); assert.match(response.headers.get('content-type'), /event-stream/);
      const raw = await response.text(); let text = '', tool, completed = false;
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data: ') || line.slice(6).trim() === '[DONE]') continue;
        const event = JSON.parse(line.slice(6)); if (event.usage) usage.push(event.usage);
        const choice = event.choices?.[0]; if (choice?.finish_reason) completed = true;
        text += choice?.delta?.content || '';
        for (const t of choice?.delta?.tool_calls || []) { tool ||= { id: '', type: 'function', function: { name: '', arguments: '' } }; if (t.id) tool.id = t.id; tool.function.name += t.function?.name || ''; tool.function.arguments += t.function?.arguments || ''; }
      }
      assert.ok(completed, 'Stream must reach a finish reason'); return { text, tool };
    }
    const text = await complete([{ role: 'user', content: 'Reply with exactly OK.' }]); assert.match(text.text, /OK/);
    const messages = [{ role: 'user', content: 'Call echo once with value OK. Do not perform any other action.' }];
    const tools = [{ type: 'function', function: { name: 'echo', description: 'Returns a supplied value; no side effects.', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }];
    const first = await complete(messages, { tools, tool_choice: { type: 'function', function: { name: 'echo' } } });
    assert.equal(first.tool?.function.name, 'echo'); assert.equal(JSON.parse(first.tool.function.arguments).value, 'OK');
    const next = await complete([...messages, { role: 'assistant', content: first.text || null, tool_calls: [first.tool] }, { role: 'tool', tool_call_id: first.tool.id, content: 'OK' }], { tools, tool_choice: 'none' }); assert.match(next.text, /OK/);
    const evidence = { kind: 'real-magpie-external-deepseek', externalModelInference: 'passed', model: profile.model, upstreamHost: 'api.deepseek.com', inferenceRequests, binarySha256: crypto.createHash('sha256').update(await fs.readFile(binary)).digest('hex'), checks: ['model discovery', 'streamed text', 'model-generated tool call', 'tool result continuation'], usage };
    await fs.writeFile(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify({ ...evidence, evidencePath: path.join(root, 'evidence.json') }, null, 2));
  } finally { gateway?.close(); child?.kill(); for (const req of upstreams) req.destroy(); relay.closeAllConnections(); relay.close(); }
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
