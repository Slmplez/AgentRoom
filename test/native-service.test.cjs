const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { HcomService, workspaceId } = require('../lib/hcom-service.cjs');
const { validateTerminalInput, validateTerminalSize } = require('../lib/terminal-contract.cjs');

test('native runtime close waits for its owned host exit', async () => {
  const { NativeRuntime } = require('../lib/native-runtime.cjs');
  const runtime = new NativeRuntime(), child = new EventEmitter(); let settled = false;
  child.kill = () => {}; runtime.child = child;
  const closing = runtime.close().then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  child.emit('exit', 0); await closing; assert.equal(settled, true);
});

async function setup(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-native-service-'));
  const runtime = new EventEmitter(); runtime.binary = path.join(directory, 'hcom.exe'); runtime.activeSessions = 2;
  runtime.snapshot = async () => ({ agents: [
    { name: 'alpha', base_name: 'alpha', tag: 'team', tool: 'pi', directory, status: 'listening' },
    { name: 'beta', base_name: 'beta', tag: 'team', tool: 'pi', directory: path.join(directory, 'elsewhere'), status: 'listening' },
  ], events: [] });
  runtime.close = async () => {};
  const service = new HcomService({ dataDir: directory, runtime, run: async () => { throw new Error('External CLI fallback must not run'); } });
  await service.usage.load(); await service.connections.load(); await service.refresh();
  t.after(async () => { await service.close(); await fs.rm(directory, { recursive: true, force: true }); });
  return { directory, runtime, service };
}
test('native messages use typed API and preserve workspace recipient boundaries', async t => {
  const { directory, runtime, service } = await setup(t);
  const calls = []; runtime.send = async p => { calls.push(p); return { event_id: 1 }; };
  await service.send({ roomId: `lobby:${workspaceId(directory)}`, text: '@team hello ; $(literal)' });
  assert.deepEqual(calls, [{ targets: ['alpha'], text: '@team hello ; $(literal)', thread: `agent-room-${workspaceId(directory)}` }]);
  assert.equal(service.snapshot().runtimeMode, 'native');
});
test('native connection launches reuse session provider adapters and release the gateway on session exit', async t => {
  const { directory, runtime, service } = await setup(t);
  const id = await service.connections.save({ name: 'Local fixture', protocol: 'chat', baseUrl: 'http://127.0.0.1:34999/v1', model: 'fixture-model', authMode: 'none' });
  let launch; runtime.launch = async p => { launch = p; return { handles: [{ instance_name: 'alpha' }], launched: 1 }; };
  await service.launch({ tool: 'pi', directory, tag: 'team', connectionId: id });
  assert.equal(launch.tool, 'pi'); assert.equal(launch.directory, directory);
  assert.ok(launch.args.includes('--extension') && launch.args.includes('--model'));
  const provider = await fs.readFile(launch.args[launch.args.indexOf('--extension') + 1], 'utf8');
  assert.ok(provider.includes('http://127.0.0.1:') && provider.includes('fixture-model'));
  assert.equal(service.gateways.size, 1);
  runtime.emit('session-exit', 'alpha'); assert.equal(service.gateways.size, 0);
});
test('terminal input limits count UTF-8 bytes and resize rejects invalid dimensions', () => {
  assert.equal(validateTerminalInput('\x03\x1b[A你好'), '\x03\x1b[A你好');
  assert.throws(() => validateTerminalInput('汉'.repeat(22000)), /64 KiB/);
  assert.throws(() => validateTerminalInput({ command: 'x' }), /文本/);
  assert.deepEqual(validateTerminalSize({ cols: 100, rows: 30 }), { cols: 100, rows: 30 });
  for (const dimensions of [{ cols: NaN, rows: 20 }, { cols: 80.5, rows: 20 }, { cols: 80, rows: 301 }, { cols: 0, rows: 20 }]) assert.throws(() => validateTerminalSize(dimensions));
});
