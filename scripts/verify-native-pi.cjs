// Real installed Pi + native hcom + local model gateway. The upstream is a
// deterministic loopback test server, so this never calls a paid model.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { NativeRuntime } = require('../lib/native-runtime.cjs');
const { hcomEnvironment } = require('../lib/hcom-service.cjs');
const { validateProfile } = require('../lib/connection-profiles.cjs');
const { startGateway } = require('../lib/model-gateway.cjs');
const { engineConnection } = require('../lib/engine-connections.cjs');
const { UsageLedger } = require('../lib/usage.cjs');
async function until(read, predicate, label) {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 200)); }
  throw new Error(`Timed out: ${label}`);
}
async function main() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-room-real-pi-'));
  const runtime = new NativeRuntime({ dataDir: directory }); let terminal = '', requests = 0, gateway, passed = false;
  runtime.on('terminal', e => { if (e.data) terminal += Buffer.from(e.data, 'base64').toString('utf8'); });
  runtime.on('failure', () => {});
  const ledger = new UsageLedger(directory); await ledger.load();
  const server = http.createServer(async (req, res) => {
    try {
      let body = ''; for await (const chunk of req) body += chunk;
      const request = JSON.parse(body);
      assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer LOCAL-TEST-UPSTREAM');
      requests++;
      const delta = request.messages.some(m => m.role === 'tool') ? { content: 'Local native integration check finished.' } : {
        tool_calls: [{ index: 0, id: 'native-test-call', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'hcom send --intent inform --thread real-pi-check --json -- "real-pi-native-ok"' }) } }],
      };
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (d, finish_reason = null, usage) => `data: ${JSON.stringify({ id: `local-${requests}`, object: 'chat.completion.chunk', created: 1, model: 'native-test-model', choices: [{ index: 0, delta: d, finish_reason }], ...(usage ? { usage } : {}) })}\n\n`;
      res.write(chunk({ role: 'assistant', ...delta }));
      res.end(chunk({}, delta.tool_calls ? 'tool_calls' : 'stop', { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }) + 'data: [DONE]\n\n');
    } catch (error) { res.writeHead(500); res.end(error.message); }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const profile = validateProfile({ name: 'Native local integration fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: 'chat', authMode: 'bearer', model: 'native-test-model', contextWindow: 128000, maxTokens: 8192 });
    gateway = await startGateway(profile, { apiKey: 'LOCAL-TEST-UPSTREAM' }, { engine: 'pi', onUsage: (metadata, usage) => ledger.record(metadata, usage) });
    const connection = await engineConnection('pi', profile, gateway, directory);
    const piHome = path.join(directory, 'pi-home'); await fs.mkdir(piHome);
    // Reuse existing CLI tool binaries without sharing credentials/settings or
    // waiting for Pi's first-run network downloads in the isolated test home.
    const toolCache = process.env.AGENT_ROOM_PI_TOOLS || path.join(os.homedir(), '.pi', 'agent', 'bin');
    await fs.mkdir(path.join(piHome, 'bin'));
    for (const tool of ['rg.exe', 'fd.exe']) {
      try { await fs.copyFile(path.join(toolCache, tool), path.join(piHome, 'bin', tool)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const inheritedPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1];
    const env = hcomEnvironment(process.env, `${path.resolve(__dirname, '../native/bin')};${inheritedPath}`, { PI_CODING_AGENT_DIR: piHome, HCOM_AUTO_TRUST_WORKSPACE: '0' });
    await runtime.start({ env });
    const launched = await runtime.launch({ tool: 'pi', directory, tag: 'native', args: connection.args, env: connection.env });
    const id = launched.handles[0].instance_name;
    await until(() => runtime.snapshot(), s => s.agents.some(a => a.base_name === id && a.hooks_bound), 'real Pi hook binding');
    await runtime.send({ targets: [id], text: 'Run the local connectivity check.', thread: 'real-pi-check' });
    await until(() => runtime.snapshot(), s => s.events.some(e => e.data.from === id && e.data.text === 'real-pi-native-ok'), 'real Pi receives a message and runs hcom send');
    await until(() => Promise.resolve(requests), count => count >= 2, 'Pi processes tool result');
    await until(() => Promise.resolve(ledger.snapshot()), s => s.totals.requests >= 2, 'usage extraction');
    await ledger.pending;
    const records = (await fs.readFile(path.join(directory, 'usage.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
    assert.ok(records.every(r => !JSON.stringify(r).includes('LOCAL-TEST-UPSTREAM')));
    const evidence = { passed: true, engine: 'real installed Pi', transport: 'Rust N-API + ConPTY', upstream: 'loopback deterministic fixture',
      paidModelCalls: 0, requests, usageRecords: records.length, checks: ['per-session-provider', 'real-Pi-hcom-extension', 'hook-bind', 'message-delivery', 'real-bash-tool-hcom-send', 'gateway-auth-replacement', 'usage-ledger'], time: new Date().toISOString() };
    await fs.writeFile(path.resolve(__dirname, '../artifacts/native-real-pi-check.json'), JSON.stringify(evidence, null, 2)); console.log(evidence); passed = true;
  } catch (error) {
    await fs.writeFile(path.resolve(__dirname, '../artifacts/native-real-pi-error.json'), JSON.stringify({ error: error.stack, terminal, requests, directory }, null, 2)); throw error;
  } finally {
    await runtime.close(); gateway?.close(); await ledger.pending;
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    if (passed) await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
