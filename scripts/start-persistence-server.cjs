const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createInterface } = require('node:readline');

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/start-persistence-server.cjs --data-dir <isolated-directory> [--port 0] [--agent-workspace <trusted-read-only-directory>] [--agent-reports]\nAgent execution is opt-in, single local owner, Pi RPC with read-only tools. Without --agent-workspace this remains discussion-only.\nStandalone launch requires a 64-character random hex token in one JSON line on stdin: {"token":"..."}. Do not log that line. With fork IPC, credentials are returned only on the private IPC channel.');
    return;
  }
  const agentReports = args.includes('--agent-reports');
  if (agentReports) args.splice(args.indexOf('--agent-reports'), 1);
  let directory, agentWorkspace, port = 0;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--data-dir' && args[i + 1]) directory = path.resolve(args[i + 1]);
    else if (args[i] === '--agent-workspace' && args[i + 1]) agentWorkspace = path.resolve(args[i + 1]);
    else if (args[i] === '--port' && /^\d+$/.test(args[i + 1] || '')) port = Number(args[i + 1]);
    else throw new Error('Use --data-dir <isolated-directory> [--port 0] [--agent-workspace <trusted-directory>] [--agent-reports].');
  }
  if (!directory) throw new Error('An explicit isolated --data-dir is required.');
  if (agentReports && !agentWorkspace) throw new Error('--agent-reports requires --agent-workspace.');
  let token;
  if (!process.send) {
    const input = createInterface({ input: process.stdin, terminal: false });
    try { const line = await new Promise((resolve, reject) => { input.once('line', resolve); input.once('close', () => reject(new Error('Provide launch credentials via stdin or fork IPC.'))); }); token = JSON.parse(line).token; }
    finally { input.close(); }
    if (!/^[a-f0-9]{64}$/.test(token || '')) throw new Error('Invalid launch credentials.');
  }
  const { createApplicationRuntime } = await import(pathToFileURL(path.join(__dirname, '../lib/application-runtime/index.mjs')));
  const { startPersistenceHttp } = await import(pathToFileURL(path.join(__dirname, '../lib/application-http/index.mjs')));
  let execution = null;
  if (agentWorkspace) {
    const { stat } = require('node:fs/promises'); if (!(await stat(agentWorkspace)).isDirectory()) throw new Error('Agent workspace must be a directory.');
    const { createPiQuestionEngine } = await import(pathToFileURL(path.join(__dirname, '../lib/local-question-engine.mjs')));
    const { createPiArtifactEngine } = await import(pathToFileURL(path.join(__dirname, '../lib/pi-artifact-engine.mjs')));
    execution = { agentId: 'local-pi', artifacts: agentReports, createEngine: ({ publishArtifact }) => agentReports ? createPiArtifactEngine({ directory: agentWorkspace, publishArtifact }) : createPiQuestionEngine({ directory: agentWorkspace }) };
  }
  const runtime = await createApplicationRuntime({ directory, execution });
  let listener;
  try { listener = await startPersistenceHttp({ runtime, port, token }); } catch (e) { runtime.close(); throw e; }
  const ready = { type: 'ready', origin: listener.origin, token: listener.token };
  if (process.send) process.send(ready); else console.log(`Persistent discussion backend: ${listener.origin}`);
  let stopping = false;
  async function stop() { if (stopping) return; stopping = true; await listener.close(); runtime.close(); if (process.connected) process.disconnect(); }
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('disconnect', stop);
  process.on('message', msg => { if (msg?.type === 'shutdown') void stop(); });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
