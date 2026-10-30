const path = require('node:path');
(async () => {
  const { createApplicationRuntime } = await import('../../lib/application-runtime/index.mjs');
  const { createPiQuestionEngine } = await import('../../lib/local-question-engine.mjs');
  const { startPersistenceHttp } = await import('../../lib/application-http/index.mjs');
  let armed;
  const directory = process.argv[2];
  const real = process.argv.includes('--real-pi') ? JSON.parse(await require('node:fs/promises').readFile(path.join(directory, 'test-pi-config.json'), 'utf8')) : null;
  const runtime = await createApplicationRuntime({ directory, execution: { agentId: 'local-pi', createEngine: () => createPiQuestionEngine({ directory, env: { ...process.env, ...(real?.env || {}), ...(real ? { PI_CODING_AGENT_DIR: path.join(directory, 'pi-home') } : {}), LOCAL_ANSWER_LOG: path.join(directory, 'native.log') }, args: real?.args || [], command: real ? undefined : { command: process.execPath, args: [path.join(__dirname, 'local-question-pi.cjs')] } }) }, fault(point) {
    if (armed === point) { process.send({ type: 'fault', point }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
  } });
  const http = await startPersistenceHttp({ runtime }); process.send({ type: 'ready', origin: http.origin, token: http.token });
  process.on('message', async m => { if (m.type === 'arm') { armed = m.point; process.send({ type: 'armed' }); } if (m.type === 'shutdown') { await http.close(); runtime.close(); process.disconnect(); } });
})().catch(e => { console.error(e); process.exitCode = 1; });
