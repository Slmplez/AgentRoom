const path = require('node:path');
(async () => {
  const { createApplicationRuntime } = await import('../../lib/application-runtime/index.mjs');
  const { createPiArtifactEngine } = await import('../../lib/pi-artifact-engine.mjs');
  const { startPersistenceHttp } = await import('../../lib/application-http/index.mjs');
  const directory = process.argv[2];
  const config = JSON.parse(await require('node:fs/promises').readFile(path.join(directory, 'test-pi-config.json'), 'utf8'));
  if (!process.argv.includes('--agent-reports')) throw Error('Report capability must be explicit');
  const runtime = await createApplicationRuntime({ directory, execution: { agentId: 'local-pi', artifacts: true, createEngine: ({ publishArtifact }) => createPiArtifactEngine({ publishArtifact, directory, env: { ...process.env, ...config.env, PI_CODING_AGENT_DIR: path.join(directory, 'pi-home') }, args: config.args }) } });
  let forbidden = false;
  const query = runtime.query;
  runtime.query = (input, actor) => { if (forbidden && input.type === 'artifact') throw Object.assign(Error('Denied by test access policy'), { code: 'forbidden', status: 403 }); return query(input, actor); };
  const http = await startPersistenceHttp({ runtime }); process.send({ type: 'ready', origin: http.origin, token: http.token });
  let original;
  process.on('message', async m => {
    if (m.type === 'test-report-state') {
      forbidden = m.mode === 'forbidden';
      const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(path.join(directory, 'application.sqlite'));
      original ||= db.prepare('SELECT * FROM artifact_versions WHERE version=1').get();
      db.prepare('DELETE FROM artifact_versions WHERE artifact_id=? AND version=1').run(original.artifact_id);
      if (m.mode !== 'missing') db.prepare('INSERT INTO artifact_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(...Object.values({ ...original, ...(m.mode === 'corrupt' ? { content_json: '{}' } : {}), ...(m.mode === 'catalog' ? { catalog_version: 2 } : {}) }));
      db.close(); process.send({ type: 'test-state-ready' });
    }
    if (m.type === 'shutdown') { await http.close(); runtime.close(); process.disconnect(); }
  });
})().catch(e => { console.error(e); process.exitCode = 1; });
