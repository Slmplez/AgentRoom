// Real backend process with an internal-only crash barrier, never an HTTP option.
(async () => {
  const { createApplicationRuntime } = await import('../../lib/application-runtime/index.mjs');
  const { startPersistenceHttp } = await import('../../lib/application-http/index.mjs');
  let armed;
  const runtime = await createApplicationRuntime({ directory: process.argv[2], knownAgents: ['iris'], fault(point) {
    if (armed !== point) return;
    process.send({ type: 'fault', point });
    // Let the IPC channel flush before a synchronous barrier in this process.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
  } });
  const listener = await startPersistenceHttp({ runtime });
  process.on('message', message => { if (message.type === 'arm') { armed = message.point; process.send({ type: 'armed' }); } });
  process.send({ type: 'ready', origin: listener.origin, token: listener.token });
})().catch(error => { console.error(error.message); process.exitCode = 1; });
