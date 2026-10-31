const path = require('node:path');
const { startPersistentHost } = require('../lib/persistence-host.cjs');

async function main() {
  const args = process.argv.slice(2).filter(value => value !== '--persistent');
  const agentForms=args.includes('--agent-forms');
  if(agentForms)args.splice(args.indexOf('--agent-forms'),1);
  const agentReports = args.includes('--agent-reports');
  if (agentReports) args.splice(args.indexOf('--agent-reports'), 1);
  let directory, editorWorkspace, agentWorkspace, consultationConfig, memoryCuratorConfig, port = 4319;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--data-dir' && args[i + 1]) directory = path.resolve(args[i + 1]);
    else if (args[i] === '--memory-curator-config' && args[i + 1]) memoryCuratorConfig = path.resolve(args[i + 1]);
    else if (args[i] === '--consultation-config' && args[i + 1]) consultationConfig = path.resolve(args[i + 1]);
    else if (args[i] === '--editor-workspace' && args[i + 1]) editorWorkspace = path.resolve(args[i + 1]);
    else if (args[i] === '--agent-workspace' && args[i + 1]) agentWorkspace = path.resolve(args[i + 1]);
    else if (args[i] === '--port' && /^\d+$/.test(args[i + 1] || '')) port = Number(args[i + 1]);
    else throw new Error('Use --persistent --data-dir <isolated-directory> [--port 4319] [--editor-workspace <trusted-edit-directory>] [--agent-workspace <read-only-directory>] [--agent-reports] [--agent-forms] [--consultation-config <trusted-json>] [--memory-curator-config <trusted-json>].');
  }
  if (!directory) throw new Error('Specify --data-dir for persistent discussion; existing hcom data is not imported.');
  const host = await startPersistentHost({ directory, port, editorWorkspace, agentWorkspace, agentReports, agentForms, consultationConfig, memoryCuratorConfig });
  console.log(`Agent Room persistent discussion: ${host.origin}\nData directory: ${directory}\nThis launcher owns the backend. Closing a browser or desktop window does not stop it.`);
  if (process.send) process.send({ type: 'ready', origin: host.origin });
  let stopping = false;
  async function stop() { if (stopping) return; stopping = true; await host.close(); if (process.connected) process.disconnect(); }
  process.on('SIGINT', stop); process.on('SIGTERM', stop); process.on('disconnect', stop);
  process.on('message', message => { if (message?.type === 'shutdown') void stop(); });
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
