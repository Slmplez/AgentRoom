const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { NativeRuntime } = require('../lib/native-runtime.cjs');
const { spawnSync } = require('node:child_process');
const { hcomEnvironment } = require('../lib/hcom-service.cjs');
const electron = process.versions.electron ? require('electron') : null;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, predicate, description) {
  const end = Date.now() + 25000;
  while (Date.now() < end) { const value = await read(); if (predicate(value)) return value; await delay(100); }
  throw new Error(`Timed out: ${description}`);
}
async function verify() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-room-native-'));
  const bin = path.join(directory, 'bin'); await fs.mkdir(bin);
  const fixture = path.resolve(__dirname, '../test/fixtures/native-agent.cjs');
  const node = process.versions.electron ? process.env.AGENT_ROOM_TEST_NODE : process.execPath;
  assert.ok(node, 'Electron check requires AGENT_ROOM_TEST_NODE');
  await fs.writeFile(path.join(bin, 'pi.cmd'), `@"${node}" "${fixture}" %*\r\n`);
  const inheritedPath = Object.entries(process.env).find(([key]) => key.toLowerCase() === 'path')?.[1];
  const env = hcomEnvironment(process.env, `${bin};${inheritedPath}`, { HCOM_AUTO_TRUST_WORKSPACE: '0' });
  const runtime = new NativeRuntime({ dataDir: directory, fork: electron?.utilityProcess.fork.bind(electron.utilityProcess) });
  const output = new Map(); const errors = []; let pushed = 0;
  runtime.on('terminal', event => {
    if (event.data) output.set(event.id, (output.get(event.id) || '') + Buffer.from(event.data, 'base64').toString('utf8'));
    if (event.type === 'error') errors.push(event.message);
  });
  runtime.on('state', () => pushed++); runtime.on('failure', error => errors.push(error.message));
  try {
    const version = await runtime.start({ env }); assert.equal(version.core, 'native');
    for (const args of [['2', 'codex'], ['--name', 'test', 'pi'], ['pty', 'pi'], ['--new-terminal'], ['resume']]) {
      const result = spawnSync(runtime.binary, args, { env: { ...runtime.env, AGENT_ROOM_SESSION: 'guard-check' }, windowsHide: true, encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, 1, `Managed launch guard: ${args.join(' ')}`);
      assert.match(result.stderr, /Create managed sessions from Agent Room/);
    }
    const launched = [];
    for (const tag of ['alpha', 'beta']) {
      const cwd = path.join(directory, tag); await fs.mkdir(cwd);
      const result = await runtime.launch({ tool: 'pi', directory: cwd, tag, args: [], env: {} });
      const id = result.handles[0].instance_name; launched.push({ id, cwd });
      assert.equal(result.handles[0].env, undefined, 'No launch environment in application receipt');
      await until(() => Promise.resolve(output.get(id) || ''), text => text.includes(`NATIVE-READY:${id}`), `ConPTY ready ${id}`);
    }
    assert.notEqual(launched[0].id, launched[1].id);
    let snapshot = await runtime.snapshot();
    for (const { id, cwd } of launched) {
      const agent = snapshot.agents.find(a => a.base_name === id);
      assert.equal(agent.directory, cwd); assert.ok(agent.hooks_bound && agent.process_bound);
      assert.ok(output.get(id).includes(cwd));
    }
    runtime.resize(launched[0].id, 100, 30);
    runtime.input(launched[0].id, 'native-input-check\r');
    await until(() => Promise.resolve(output.get(launched[0].id)), text => text.includes('NATIVE-ECHO:native-input-check'), 'interactive input');
    assert.ok(!output.get(launched[1].id).includes('NATIVE-ECHO:native-input-check'), 'PTY input stays in its session');
    const receipt = await runtime.send({ text: 'native-message-check', targets: [launched[0].id], thread: 'native-check' });
    assert.ok(receipt.event_id > 0);
    snapshot = await until(() => runtime.snapshot(), s => s.events.some(e => e.data.from === launched[0].id && e.data.text === 'fixture-reply:native-message-check'), 'message and hook acknowledgement');
    assert.ok(!snapshot.events.some(e => e.data.from === launched[1].id && e.data.text === 'fixture-reply:native-message-check'));
    runtime.input(launched[0].id, `peer:${launched[1].id}\r`);
    await until(() => runtime.snapshot(), s => s.events.some(e => e.data.text === `peer-from:${launched[0].id}` && e.data.delivered_to.includes(launched[1].id)), 'agent-to-agent message');
    assert.ok(pushed > 0); assert.deepEqual(errors, []);
    const terminal = await runtime.terminal(launched[0].id); assert.ok(terminal.chunks.length > 0 && terminal.alive);
    const closing = runtime.close(); assert.equal(runtime.close(), closing, 'Concurrent shutdowns await the same cleanup');
    await closing; assert.equal(runtime.activeSessions, 0);
    const evidence = { passed: true, host: electron ? 'electron-utility-process' : 'node-child-process', core: version, sessions: launched.length,
      checks: ['native-library-load', 'managed-launch-guard', 'ConPTY-output', 'per-session-cwd-and-identity', 'terminal-input-isolation', 'terminal-resize', 'hook-registration', 'notify-read-ack-reply', 'agent-to-agent-message', 'state-push', 'owned-session-shutdown', 'shared-shutdown-promise'],
      modelCalls: 0, time: new Date().toISOString() };
    const target = path.resolve(__dirname, `../artifacts/native-${electron ? 'electron' : 'node'}-check.json`);
    await fs.writeFile(target, JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    const failure = { error: error.stack, output: Object.fromEntries(output), errors, directory };
    await fs.writeFile(path.resolve(__dirname, `../artifacts/native-${electron ? 'electron' : 'node'}-error.json`), JSON.stringify(failure, null, 2));
    console.error(failure); throw error;
  } finally { await runtime.close(); await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); }
}
if (electron) electron.app.whenReady().then(verify).then(() => electron.app.quit()).catch(error => { console.error(error); electron.app.exit(1); });
else verify().catch(error => { console.error(error); process.exitCode = 1; });
