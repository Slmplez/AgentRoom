// Installed Pi CLI + real SQLite + local streaming inference only. No paid model.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const http = require('node:http');
const { validateProfile } = require('../lib/connection-profiles.cjs');
const { engineConnection } = require('../lib/engine-connections.cjs');
(async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'ar-curator-verification-'));
  const failure = process.argv.includes('--failure');
  const configured = process.argv.includes('--configured');
  const oversized = process.argv.includes('--oversize');
  let calls = 0, db, curator, captured, providerError;
  const provider = http.createServer(async (req, res) => {
    try {
      assert.equal(req.url, '/v1/chat/completions'); assert.equal(req.headers.authorization, 'Bearer LOOPBACK-ONLY');
      let body = ''; for await (const chunk of req) body += chunk;
      const data = JSON.parse(body); calls++;
      assert.equal((data.tools || []).length, 0, 'Curator must have zero tools, including MCP');
      const texts = data.messages.flatMap(m => typeof m.content === 'string' ? [m.content] : (m.content || []).filter(p => p.type === 'text').map(p => p.text));
      captured = texts.find(text => text.includes('你是记忆整理员。'));
      assert.ok(captured); const { inputs } = JSON.parse(captured.split('\n').at(-1));
      assert.deepEqual(new Set(inputs.map(i => i.text)), new Set(['先给结论', '再解释依据']));
      assert.ok(texts.every(text => !text.includes('SOUL_MUST_STAY_PRIVATE')));
      if (failure) { res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Local transient failure fixture', type: 'server_error' } })); return; }
      const text = oversized ? 'x'.repeat(65537) : JSON.stringify({ summaries: [{ inputs: inputs.map(i => i.key), text: '先给结论，再解释依据。', reason: '合并同一 Agent 的两条互补表达偏好。' }], archives: [] });
      const base = { id: 'curation-local', model: 'memory-fixture', created: 1, object: 'chat.completion.chunk' };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }) + '\n\ndata: [DONE]\n\n');
    } catch (e) { providerError = e; res.writeHead(500); res.end('Fixture rejected unexpected request.'); }
  });
  try {
    await new Promise(r => provider.listen(0, '127.0.0.1', r));
    const profile = validateProfile({ name: 'Curator fixture', baseUrl: `http://127.0.0.1:${provider.address().port}`, protocol: 'chat', authMode: 'bearer', model: 'memory-fixture', contextWindow: 128000, maxTokens: 8192 });
    const config = await engineConnection('pi', profile, { baseUrl: profile.baseUrl, token: 'LOOPBACK-ONLY' }, directory);
    const { openStorage } = await import('../lib/application-runtime/storage.mjs');
    const { agentMemory } = await import('../lib/application-runtime/agent-memory.mjs');
    const { createMemoryCurator } = await import('../lib/application-runtime/memory-curation.mjs');
    const { createPiMemoryCuratorEngine } = await import('../lib/pi-memory-curator.mjs');
    db = await openStorage(join(directory, 'db'), 5000);
    const atomic = fn => { db.exec('BEGIN IMMEDIATE'); try { const result = fn(); db.exec('COMMIT'); return result; } catch (e) { db.exec('ROLLBACK'); throw e; } };
    const scope = { kind: 'agent', agentId: 'iris' }, memories = agentMemory(db), actor = { id: db.prepare('SELECT owner_id FROM database_meta').get().owner_id };
    atomic(() => {
      memories.apply({ type: 'editAgentSoul', agentId: 'iris', expectedRevision: 0, personality: 'SOUL_MUST_STAY_PRIVATE', expression: '清晰', workStyle: '严谨' }, actor, new Date().toISOString());
      for (const text of ['先给结论', '再解释依据']) memories.apply({ type: 'saveExplicitMemory', scope, text, source: { kind: 'owner-note' } }, actor, new Date().toISOString());
    });
    let engine = { agentId: 'memory-curator', model: 'memory-fixture', createEngine: ({ executionTag }) => createPiMemoryCuratorEngine({ args: config.args, env: { ...process.env, ...config.env }, executionTag }) };
    if (configured) {
      const { loadMemoryCuratorConfig } = await import('../lib/memory-curator-config.mjs');
      const file = join(directory, 'curator.json');
      await fs.writeFile(file, JSON.stringify({ version: 1, agentId: 'memory-curator', displayName: '本地验证整理员', model: 'memory-fixture', connection: { baseUrl: profile.baseUrl + '/v1', protocol: 'chat', authMode: 'bearer', credentialEnv: 'CURATOR_FIXTURE_TOKEN', maxTokens: 8192 } }));
      engine = await loadMemoryCuratorConfig(file, { env: { ...process.env, CURATOR_FIXTURE_TOKEN: 'LOOPBACK-ONLY' } });
      assert.doesNotMatch(JSON.stringify(engine), /LOOPBACK-ONLY/);
      assert.equal(calls, 0, 'Loading a host configuration must not call a model');
    }
    curator = createMemoryCurator({ db, atomic, allowedScope: s => s.kind === 'agent' && s.agentId === 'iris', engine });
    await curator.tick(); if (providerError) throw providerError;
    if (failure || oversized) {
      assert.equal(calls, 1, 'Pi must not retry transient provider failures');
      assert.equal(curator.status(scope).summaries.length, 0);
      assert.equal(curator.status(scope).latestRun.status, 'unknown');
      await curator.tick(); assert.equal(calls, 1);
      console.log(`PASS: real Pi ${oversized ? 'oversized stream' : 'transient 503'} produced exactly 1 local request, 0 retries, 0 applied summaries, 0 paid calls.`); return;
    }
    const state = curator.status(scope); assert.equal(state.latestRun.status, 'applied', JSON.stringify(state.latestRun));
    assert.equal(state.summaries[0].text, '先给结论，再解释依据。');
    assert.equal(state.summaries[0].refs.length, 2);
    assert.equal(curator.history(scope).runs[0].input.prompt, captured, 'Exactly the persisted input reached the real CLI');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memory_revisions').get().n, 2);
    assert.equal(calls, 1);
    console.log('PASS: installed Pi → zero-tools request → loopback structured curation → atomic SQLite projection; exact input/provenance retained; Soul unchanged; 1 local call, 0 paid calls.');
  } finally { curator?.shutdown(); db?.close(); await new Promise(r => provider.close(r)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
