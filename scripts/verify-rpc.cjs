// Installed CLIs, native hcom bus and deterministic loopback inference. No paid requests.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { RpcRuntime } = require('../lib/rpc-runtime.cjs');
const { createEngine } = require('../lib/rpc/engines.cjs');
const { hcomEnvironment } = require('../lib/hcom-service.cjs');
const { validateProfile } = require('../lib/connection-profiles.cjs');
const { startGateway } = require('../lib/model-gateway.cjs');
const { engineConnection } = require('../lib/engine-connections.cjs');
const tool = process.argv[2] || 'pi';
async function until(read, predicate, label) {
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) { const result = await read(); if (predicate(result)) return result; await new Promise(r => setTimeout(r, 150)); }
  throw new Error('Timed out: ' + label);
}
async function main({ fork } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `agent-room-rpc-${tool}-`)); let gateway, requests = 0, terminalEvents = 0, passed = false, relay;
  const runtime = new RpcRuntime({ dataDir: directory, fork, createEngine: o => createEngine({ ...o, serverArgs: ['--pure'] }) });
  runtime.on('failure', e => console.error('Runtime:', e.message)); runtime.on('terminal', () => terminalEvents++);
  const server = http.createServer(async (req, res) => {
    try {
      let raw = ''; for await (const b of req) raw += b; requests++; const data = JSON.parse(raw);
      assert.equal(req.url, tool === 'codex' ? '/v1/responses' : '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer LOCAL-RPC-TEST');
      const text = 'real-' + tool + '-rpc-ok';
      const toolCall = tool === 'pi' && relay && JSON.stringify(data.messages).includes('relay-trigger') && data.messages.at(-1)?.role !== 'tool' ? [{ index: 0, id: 'rpc-peer-send', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `hcom send --name ${relay.from} @${relay.to} --intent request --thread rpc-peer -- "relay-ping"` }) } }] : null;
      if (tool === 'codex') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        const item = { id: 'msg_local', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
        const base = { id: 'resp_local', object: 'response', model: 'rpc-test-model', output: [], status: 'in_progress' };
        const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        event('response.created', { response: base });
        event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
        event('response.content_part.added', { output_index: 0, content_index: 0, item_id: item.id, part: { type: 'output_text', text: '', annotations: [] } });
        event('response.output_text.delta', { output_index: 0, content_index: 0, item_id: item.id, delta: text });
        event('response.output_text.done', { output_index: 0, content_index: 0, item_id: item.id, text });
        event('response.content_part.done', { output_index: 0, content_index: 0, item_id: item.id, part: item.content[0] });
        event('response.output_item.done', { output_index: 0, item });
        event('response.completed', { response: { ...base, status: 'completed', output: [item], usage: { input_tokens: 12, output_tokens: 6, total_tokens: 18, input_tokens_details: { cached_tokens: 0 } } } }); return res.end();
      }
      const reply = { id: 'local-' + requests, object: 'chat.completion', created: 1, model: 'rpc-test-model', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } };
      if (!data.stream) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(reply)); }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ ...reply, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', ...(toolCall ? { tool_calls: toolCall } : { content: text }) }, finish_reason: null }], usage: undefined }) + '\n\n');
      res.end('data: ' + JSON.stringify({ ...reply, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: toolCall ? 'tool_calls' : 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } catch (e) { res.writeHead(500); res.end(e.message); }
  });
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const profile = validateProfile({ name: 'RPC loopback fixture', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, protocol: tool === 'codex' ? 'responses' : 'chat', authMode: 'bearer', model: 'rpc-test-model', contextWindow: 128000, maxTokens: 8192 });
    gateway = await startGateway(profile, { apiKey: 'LOCAL-RPC-TEST' }, { engine: tool });
    const connection = await engineConnection(tool, profile, gateway, directory);
    const piHome = path.join(directory, 'pi-home'); await fs.mkdir(path.join(piHome, 'bin'), { recursive: true });
    for (const name of ['rg.exe', 'fd.exe']) try { await fs.copyFile(path.join(os.homedir(), '.pi/agent/bin', name), path.join(piHome, 'bin', name)); } catch {}
    const codexHome = path.join(directory, 'codex-home'); await fs.mkdir(codexHome);
    const env = hcomEnvironment(process.env, undefined, { CODEX_HOME: codexHome, PI_CODING_AGENT_DIR: piHome, OPENCODE_DISABLE_AUTOUPDATE: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true' });
    await runtime.start({ env });
    // Assert production RPC cannot silently reach the PTY implementation.
    runtime.startSession = () => { throw new Error('PTY is forbidden in this verification'); };
    if (tool === 'pi') connection.args.unshift('--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes');
    const launched = await runtime.launch({ tool, directory, tag: 'rpc', ...connection });
    const id = launched.handles[0].instance_name;
    await runtime.send({ targets: [id], text: 'Reply to this local RPC integration check.', thread: 'rpc-check' });
    const result = await until(() => runtime.snapshot(), s => s.events.some(e => e.data.from === id && e.data.text === `real-${tool}-rpc-ok`), 'real reply through hcom');
    const reply = result.events.find(e => e.data.from === id && e.data.text === `real-${tool}-rpc-ok`);
    assert.equal(reply.data.thread, 'rpc-check'); assert.ok(reply.data.reply_to); assert.equal(terminalEvents, 0); assert.equal(runtime.sessions.size, 0);
    if (tool === 'pi') {
      const peer = await runtime.launch({ tool, directory, tag: 'peer', ...connection });
      relay = { from: id, to: peer.handles[0].instance_name };
      await until(() => Promise.resolve(runtime.inspect(id)), s => !s.current, 'first turn idle');
      await runtime.send({ targets: [id], text: 'relay-trigger: send the local peer test message.', thread: 'rpc-check' });
      await until(() => runtime.snapshot(), s => s.events.some(e => e.data.from === relay.to && e.data.thread === 'rpc-peer' && e.data.text.trim() === 'real-pi-rpc-ok'), 'agent-to-agent hcom send and peer RPC reply');
      await runtime.stop(relay.to);
    }
    const evidence = { passed: true, engine: tool, transport: tool === 'opencode' ? 'HTTP + authenticated SSE' : 'stdio RPC', upstream: 'loopback deterministic model', requests, terminalEvents, ptySessions: runtime.sessions.size, paidModelCalls: 0, checks: ['actual CLI', 'native registration', 'hcom inbox delivery', 'gateway auth replacement', 'streamed final reply in original thread', 'no PTY'], time: new Date().toISOString() };
    if (relay) evidence.checks.push('actual bash tool sends hcom message to another RPC agent');
    await runtime.stop(id); assert.equal(runtime.activeSessions, 0); passed = true;
    await fs.writeFile(path.resolve(__dirname, `../artifacts/rpc-real-${tool}.json`), JSON.stringify(evidence, null, 2)); console.log(evidence);
  } catch (error) {
    await fs.writeFile(path.resolve(__dirname, `../artifacts/rpc-real-${tool}-error.json`), JSON.stringify({ error: error.stack, directory, requests, sessions: [...runtime.rpcSessions.values()].map(s => ({ name: s.name, ...runtime.view(s), stderr: s.engine?.pipe.stderr })) }, null, 2)); throw error;
  } finally {
    await runtime.close(); gateway?.close(); server.closeAllConnections(); await new Promise(r => server.close(r));
    if (passed) await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}
if (require.main === module || process.versions.electron && process.type === 'browser') {
  if (process.versions.electron && !process.env.ELECTRON_RUN_AS_NODE) {
    const { app, utilityProcess } = require('electron');
    app.whenReady().then(() => main({ fork: utilityProcess.fork.bind(utilityProcess) })).then(() => app.quit(), error => { console.error(error); app.exit(1); });
  } else main().catch(e => { console.error(e); process.exitCode = 1; });
}
module.exports = { main };
