const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const { createApplicationRuntime } = await import(pathToFileURL(path.join(__dirname, '../../lib/application-runtime/index.mjs')));
  const { startPersistenceHttp } = await import(pathToFileURL(path.join(__dirname, '../../lib/application-http/index.mjs')));
  let now = Number(process.argv[3]), crashAt;
  const runtime = await createApplicationRuntime({ directory: process.argv[2], clock: () => now, maintenanceIntervalMs: 20, fault(point) {
    if (point === crashAt) { process.send({ type: 'fault', point }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); }
  } });
  const http = await startPersistenceHttp({ runtime });
  process.send({ type: 'ready', origin: http.origin, token: http.token });
  process.on('message', async message => {
    if (message.type === 'clock') { now = message.now; process.send({ type: 'clock-set' }); }
    if (message.type === 'arm') { crashAt = message.point; process.send({ type: 'armed' }); }
    if (message.type === 'shutdown') { await http.close(); runtime.close(); process.disconnect(); }
  });
})().catch(error => { console.error(error); process.exitCode = 1; });
