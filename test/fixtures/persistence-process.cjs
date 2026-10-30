const { pathToFileURL } = require('node:url');
const path = require('node:path');
(async () => {
  const { createApplicationRuntime } = await import(pathToFileURL(path.join(__dirname, '../../lib/application-runtime/index.mjs')));
  const { startPersistenceHttp } = await import(pathToFileURL(path.join(__dirname, '../../lib/application-http/index.mjs')));
  let crashAt;
  const runtime = await createApplicationRuntime({ directory: process.argv[2], busyTimeoutMs: 100, fault(point) {
    if (point === crashAt) { process.send({ type: 'fault', point }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
  } });
  const listener = await startPersistenceHttp({ runtime });
  process.send({ type: 'ready', origin: listener.origin, token: listener.token });
  process.on('message', async msg => {
    if (msg.type === 'arm') { crashAt = msg.point; process.send({ type: 'armed' }); }
    if (msg.type === 'shutdown') { await listener.close(); runtime.close(); process.disconnect(); }
  });
})().catch(e => { console.error(e); process.exitCode = 1; });
