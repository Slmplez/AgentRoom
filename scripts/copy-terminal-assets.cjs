const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const destination = path.join(root, 'renderer', 'vendor');
fs.mkdirSync(destination, { recursive: true });
for (const [source, target] of [
  ['@xterm/xterm/lib/xterm.js', 'xterm.js'], ['@xterm/xterm/css/xterm.css', 'xterm.css'],
  ['@xterm/addon-fit/lib/addon-fit.js', 'addon-fit.js'],
  ['@xterm/xterm/LICENSE', 'xterm-LICENSE'], ['@xterm/addon-fit/LICENSE', 'addon-fit-LICENSE'],
]) fs.copyFileSync(path.join(root, 'node_modules', source), path.join(destination, target));
