const path = require('node:path');
const fs = require('node:fs/promises');
const { watch: watchFile } = require('node:fs');
const { build, context } = require('esbuild');
const root = path.resolve(__dirname, '..');
async function buildRenderer({ watch = false } = {}) {
  const clientOptions = { entryPoints: { client: path.join(root, 'renderer/client/entry.mjs') }, outdir: path.join(root, 'renderer/vendor/client'), bundle: true,
    format: 'iife', platform: 'browser', target: 'chrome130', minify: !watch, logLevel: 'warning' };
  await fs.mkdir(path.join(root, 'renderer/vendor'), { recursive: true });
  await fs.copyFile(path.join(root, 'shared/mentions.cjs'), path.join(root, 'renderer/vendor/mentions.js'));
  const outdir = path.join(root, 'renderer/vendor/diffs');
  const diffOptions = { entryPoints: { diffs: path.join(root, 'renderer/diffs-entry.mjs') }, outdir, bundle: true,
    format: 'esm', splitting: true, platform: 'browser', target: 'chrome130', minify: true,
    loader: { '.wasm': 'binary' }, logLevel: 'warning' };
  await fs.mkdir(outdir, { recursive: true });
  await fs.copyFile(path.join(root, 'node_modules/@pierre/diffs/LICENSE.md'), path.join(outdir, 'LICENSE.txt'));
  const options = { entryPoints: { chat: path.join(root, 'renderer/chat/entry.tsx') }, outdir: path.join(root, 'renderer/vendor/chat'), bundle: true,
    format: 'esm', splitting: true, platform: 'browser', target: 'chrome130', minify: !watch,
    jsx: 'automatic', legalComments: 'linked', define: { 'process.env.NODE_ENV': JSON.stringify(watch ? 'development' : 'production') }, logLevel: 'warning' };
  await fs.mkdir(options.outdir, { recursive: true });
  for (const dependency of ['react', 'react-dom', '@assistant-ui/react', '@assistant-ui/core', '@assistant-ui/store', '@assistant-ui/react-markdown', 'zod']) {
    await fs.copyFile(path.join(root, 'node_modules', dependency, 'LICENSE'), path.join(options.outdir, `LICENSE-${dependency.replace(/[@/]/g, '-')}.txt`));
  }
  await fs.copyFile(path.join(root, 'renderer/chat/LICENSE.json-render.txt'), path.join(options.outdir, 'LICENSE-json-render.txt'));
  await fs.copyFile(path.join(root, 'node_modules/mermaid/LICENSE'), path.join(options.outdir, 'LICENSE-mermaid.txt'));
  await fs.copyFile(path.join(root, 'node_modules/remark-gfm/license'), path.join(options.outdir, 'LICENSE-remark-gfm.txt'));
  await fs.copyFile(path.join(root, 'node_modules/@radix-ui/react-select/LICENSE'), path.join(options.outdir, 'LICENSE-radix-select.txt'));
  if (watch) {
    const watchers = await Promise.all([clientOptions, diffOptions, options].map(config => context(config)));
    try { await Promise.all(watchers.map(async watcher => { await watcher.rebuild(); await watcher.watch(); })); }
    catch (error) { await Promise.all(watchers.map(watcher => watcher.dispose())); throw error; }
    const mentions = watchFile(path.join(root, 'shared/mentions.cjs'), () => {
      void fs.copyFile(path.join(root, 'shared/mentions.cjs'), path.join(root, 'renderer/vendor/mentions.js')).catch(error => console.error(error.message));
    });
    return { async dispose() { mentions.close(); await Promise.all(watchers.map(watcher => watcher.dispose())); } };
  }
  await Promise.all([clientOptions, diffOptions, options].map(config => build(config)));
}
module.exports = { buildRenderer };
if (require.main === module) buildRenderer().catch(error => { console.error(error); process.exitCode = 1; });
