const path = require('node:path');
const fs = require('node:fs/promises');
const { build, context } = require('esbuild');
const root = path.resolve(__dirname, '..');
async function buildRenderer({ watch = false } = {}) {
  await build({ entryPoints: { client: path.join(root, 'renderer/client/entry.mjs') }, outdir: path.join(root, 'renderer/vendor/client'), bundle: true,
    format: 'iife', platform: 'browser', target: 'chrome130', minify: !watch, logLevel: 'warning' });
  await fs.copyFile(path.join(root, 'shared/mentions.cjs'), path.join(root, 'renderer/vendor/mentions.js'));
  const outdir = path.join(root, 'renderer/vendor/diffs');
  await build({ entryPoints: { diffs: path.join(root, 'renderer/diffs-entry.mjs') }, outdir, bundle: true,
    format: 'esm', splitting: true, platform: 'browser', target: 'chrome130', minify: true,
    loader: { '.wasm': 'binary' }, logLevel: 'warning' });
  await fs.copyFile(path.join(root, 'node_modules/@pierre/diffs/LICENSE.md'), path.join(outdir, 'LICENSE.txt'));
  const options = { entryPoints: { chat: path.join(root, 'renderer/chat/entry.tsx') }, outdir: path.join(root, 'renderer/vendor/chat'), bundle: true,
    format: 'esm', splitting: true, platform: 'browser', target: 'chrome130', minify: !watch,
    jsx: 'automatic', legalComments: 'linked', define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') }, logLevel: 'warning' };
  await fs.mkdir(options.outdir, { recursive: true });
  for (const dependency of ['react', 'react-dom', '@assistant-ui/react', '@assistant-ui/core', '@assistant-ui/store', '@assistant-ui/react-markdown', 'zod']) {
    await fs.copyFile(path.join(root, 'node_modules', dependency, 'LICENSE'), path.join(options.outdir, `LICENSE-${dependency.replace(/[@/]/g, '-')}.txt`));
  }
  if (watch) { const watcher = await context(options); await watcher.rebuild(); await watcher.watch(); return watcher; }
  await build(options);
}
module.exports = { buildRenderer };
if (require.main === module) buildRenderer().catch(error => { console.error(error); process.exitCode = 1; });
