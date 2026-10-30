// Pauses inside the actual SQLite transaction so the parent can kill this
// process without running exception handlers or graceful shutdown.
const fs = require('node:fs');
const path = require('node:path');
(async () => {
  const { createApplicationRuntime } = await import('../../lib/application-runtime/index.mjs');
  const directory = process.argv[2];
  let publish, armed;
  const runtime = await createApplicationRuntime({ directory, fault(point) {
    if (point !== armed) return;
    process.send({ type: 'fault' });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }, execution: { agentId: 'crash-agent', artifacts: true, createEngine(context) {
    publish = context.publishArtifact;
    fs.appendFileSync(path.join(directory, 'starts.log'), 'start\n');
    return { onQuestion() {}, async start() {}, prompt: () => new Promise(() => {}), async close() {} };
  } } });
  const actor = runtime.owner, workspaceId = runtime.query({ type: 'bootstrap' }, actor).workspace.id;
  const roomId = runtime.execute({ type: 'createRoom', workspaceId, key: 'room', title: 'Crash' }, actor).roomId;
  const taskId = runtime.execute({ type: 'createLocalTask', workspaceId, roomId, key: 'task', ownerAgentId: 'crash-agent', goal: 'Report' }, actor).taskId;
  while (runtime.query({ type: 'localTask', roomId, taskId }, actor).phase !== 'running') await new Promise(r => setTimeout(r, 5));
  const task = runtime.query({ type: 'localTask', roomId, taskId }, actor);
  process.on('message', m => { armed = m.point; publish(m.command); });
  process.send({ type: 'ready', workspaceId, roomId, taskId, runId: task.runId });
})().catch(error => { console.error(error); process.exit(1); });
