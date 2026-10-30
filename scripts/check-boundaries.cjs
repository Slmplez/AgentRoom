// Static guard for the frontend contract boundary; no backend startup required.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function files(directory) {
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    if (entry.name === 'vendor') return [];
    const name = `${directory}/${entry.name}`;
    return entry.isDirectory() ? files(name) : /\.(?:[cm]?js|tsx?)$/.test(name) ? [name] : [];
  });
}
const violations = [];
function reject(file, source, pattern, rule) {
  if (pattern.test(source)) violations.push(`${file}: ${rule}`);
}
for (const file of [...files('lib'), 'main.cjs', 'server.cjs']) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  reject(file, source, /(?:from\s*|require\s*\(|import\s*\()\s*['"][^'"]*renderer\//, 'backend must not import renderer implementation');
}
for (const file of [...files('contracts'), ...files('shared')]) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  reject(file, source, /(?:from\s*|require\s*\(|import\s*\()\s*['"](?:node:|electron|(?:\.\.\/)+(?:lib|renderer)\/|@(?:openai|anthropic-ai)\/)/, 'contracts and shared logic must remain platform-independent');
  reject(file, source, /\bprocess\.|\b(?:Buffer|ipcRenderer|ipcMain)\b/, 'contracts must not use host globals');
}
for (const file of files('renderer')) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  reject(file, source, /(?:from\s*|require\s*\(|import\s*\()\s*['"](?:node:|electron|(?:\.\.\/)+lib\/)/, 'renderer must not import backend or host implementations');
  if (file.startsWith('renderer/client/')) {
    if (!['renderer/client/transport.mjs', 'renderer/client/bootstrap.mjs'].includes(file)) reject(file, source, /\b(?:fetch|EventSource|ipcRenderer)\b|\b(?:window|globalThis)\.agentRoom\w*/, 'only transport/bootstrap adapters access host or network');
    continue;
  }
  reject(file, source, /\b(?:fetch|EventSource|ipcRenderer)\b|\b(?:window|globalThis)\.agentRoom\w*|\.rpc\b|\.sessionId\b|agent-room-(?:dm-)?\$?\{/, 'pages must use Client/Platform interfaces, not wire protocols');
  reject(file, source, /\b(?:setInterval|XMLHttpRequest|WebSocket)\s*\(/, 'page communication and polling belong to Client');
}
if (violations.length) { console.error(violations.join('\n')); process.exitCode = 1; }
else console.log('Client boundaries passed: backend, shared contracts, UI and transport adapters.');
