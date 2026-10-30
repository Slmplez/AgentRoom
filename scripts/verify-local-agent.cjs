// Real installed Pi CLI, native RPC input and loopback-only inference; no hcom.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { validateProfile } = require('../lib/connection-profiles.cjs');
const { engineConnection } = require('../lib/engine-connections.cjs');
(async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentroom-real-local-agent-')); let count = 0, runtime, listener;
  const provider = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer LOCAL-ONLY');
      let body = ''; for await (const chunk of req) body += chunk; const data = JSON.parse(body); count++;
      assert.ok(JSON.stringify(data.messages).includes('保留两周'));
      assert.ok((data.tools || []).every(t => ['read', 'grep', 'find', 'ls'].includes(t.function.name)));
      const reply = { id: 'local-check', object: 'chat.completion', created: 1, model: 'local-question-model', choices: [{ index: 0, message: { role: 'assistant', content: 'native-question-roundtrip-ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      res.writeHead(200, { 'Content-Type': data.stream ? 'text/event-stream' : 'application/json' });
      if (!data.stream) return res.end(JSON.stringify(reply));
      res.write('data: ' + JSON.stringify({ ...reply, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'native-question-roundtrip-ok' }, finish_reason: null }], usage: undefined }) + '\n\n');
      res.end('data: ' + JSON.stringify({ ...reply, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    } catch (e) { res.writeHead(500); res.end(e.message); }
  });
  const until = async read => { const end = Date.now() + 45000; while (Date.now() < end) { const t = await read(); if (t) return t; await new Promise(r => setTimeout(r, 80)); } throw Error('Timed out waiting for real Pi'); };
  try {
    await new Promise(r => provider.listen(0, '127.0.0.1', r));
    const profile = validateProfile({ name: 'Local only', baseUrl: `http://127.0.0.1:${provider.address().port}`, protocol: 'chat', authMode: 'bearer', model: 'local-question-model', contextWindow: 128000, maxTokens: 8192 });
    const config = await engineConnection('pi', profile, { baseUrl: profile.baseUrl, token: 'LOCAL-ONLY' }, directory);
    const extension = path.join(directory, 'ask.mjs');
    await fs.writeFile(extension, `export default function(pi) { pi.on('before_agent_start', async (_,ctx) => { const answer=await ctx.ui.input('旧接口兼容期限？','请输入期限'); return {message:{customType:'local-clarification',content:'真人答复：'+answer,display:false}}; }); }`);
    const { createApplicationRuntime } = await import('../lib/application-runtime/index.mjs');
    const { createPiQuestionEngine } = await import('../lib/local-question-engine.mjs');
    const { startPersistenceHttp } = await import('../lib/application-http/index.mjs');
    runtime = await createApplicationRuntime({ directory: path.join(directory, 'db'), execution: { agentId: 'local-pi', createEngine: () => createPiQuestionEngine({ directory, env: { ...process.env, ...config.env, PI_CODING_AGENT_DIR: path.join(directory, 'pi-home') }, args: [...config.args, '--extension', extension] }) } });
    listener = await startPersistenceHttp({ runtime });
    const request = async (route, input, key) => {
      const response = await fetch(listener.origin + '/api/v1' + route, { method: input ? 'POST' : 'GET', headers: { authorization: `Bearer ${listener.token}`, ...(input ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
      const body = await response.json(); assert.equal(response.status, 200, JSON.stringify(body)); return body;
    };
    const boot = await request('/bootstrap'), workspaceId = boot.workspace.id;
    const { roomId } = await request('/rooms', { workspaceId, title: 'Real CLI check' }, 'room');
    const route = `/rooms/${roomId}/local-tasks`;
    const { taskId } = await request(route, { workspaceId, ownerAgentId: 'local-pi', goal: '请先询问兼容期限，然后简短确认。' }, 'task');
    const waiting = await until(async () => { const t = await request(`${route}/${taskId}`); if (t.phase === 'unknown') throw Error(t.result); return t.phase === 'awaiting_input' && t; });
    assert.equal(count, 0, 'No model call happens while waiting for the native input');
    await request(`${route}/${taskId}/answers`, { workspaceId, questionId: waiting.question.id, expectedRevision: 0, optionIds: [], text: '保留两周' }, 'answer');
    const done = await until(async () => { const t = await request(`${route}/${taskId}`); if (t.phase === 'unknown') throw Error(t.result); return t.phase === 'reviewing' && t; });
    assert.equal(done.result, 'native-question-roundtrip-ok'); assert.equal(done.question.response.text, '保留两周'); assert.equal(count, 1);
    console.log('Passed: installed Pi CLI → native input → durable HTTP answer → original CLI continuation → loopback inference; 1 local request, 0 paid calls.');
  } finally { await listener?.close(); runtime?.close(); await new Promise(r => provider.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
