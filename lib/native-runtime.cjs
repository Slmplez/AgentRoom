const { EventEmitter } = require('node:events');
const path = require('node:path');
const fs = require('node:fs/promises');
const { fork: nodeFork } = require('node:child_process');
const { validateTerminalInput, validateTerminalSize } = require('./terminal-contract.cjs');

// Typed application API. Only runtime-host loads the native module; never the renderer/main process.
class NativeRuntime extends EventEmitter {
  constructor({ dataDir, fork, resourcesPath } = {}) {
    super();
    this.dataDir = dataDir;
    this.fork = fork;
    this.root = resourcesPath || path.join(__dirname, '..', 'native', 'bin');
    this.binary = path.join(this.root, 'hcom.exe');
    this.modulePath = path.join(this.root, 'agent_room_hcom.node');
    this.pending = new Map(); this.nextId = 0; this.activeSessions = 0; this.sessions = new Map();
  }
  async start({ env }) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(this.root, 'runtime.json'), 'utf8'));
      if (!/^[a-f0-9]{32}$/.test(manifest.build)) throw new Error('Invalid native build manifest');
      this.binary = path.join(this.root, manifest.build, 'hcom.exe');
      this.modulePath = path.join(this.root, manifest.build, 'agent_room_hcom.node');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await Promise.all([fs.access(this.binary), fs.access(this.modulePath)]);
    this.env = { ...env, HCOM_DIR: path.join(this.dataDir, 'runtime'), AGENT_ROOM_HCOM_HELPER: this.binary, AGENT_ROOM_NATIVE_MODULE: this.modulePath };
    const pathKey = Object.keys(this.env).find(key => key.toLowerCase() === 'path');
    const inheritedPath = pathKey ? this.env[pathKey] : '';
    if (pathKey) delete this.env[pathKey];
    this.env.PATH = `${path.dirname(this.binary)}${path.delimiter}${inheritedPath}`;
    delete this.env.AGENT_ROOM_SESSION;
    this.child = this.spawn({ env: this.env, serviceName: 'Agent Room Runtime' });
    this.child.on('message', message => this.receive(message));
    this.child.on('exit', code => {
      const error = new Error(`原生会话运行进程已退出（${code}），请重新打开应用。`);
      for (const { reject, timer } of this.pending.values()) { clearTimeout(timer); reject(error); }
      this.pending.clear(); this.exited = true;
      if (!this.closing) { this.emit('failure', error); this.close().catch(failure => this.emit('failure', failure)); }
    });
    return this.call('initialize');
  }
  spawn(options) {
    const hostPath = path.join(__dirname, 'runtime-host.cjs');
    const child = this.fork ? this.fork(hostPath, [], { ...options, stdio: 'pipe' }) : nodeFork(hostPath, [], { ...options, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    child.stdout?.on('data', () => {}); child.stderr?.on('data', () => {});
    return child;
  }
  receive(message) {
    if (message.event === 'state') { this.current = message.value; this.emit('state'); }
    else if (message.event === 'terminal') this.emit('terminal', message.value);
    else if (message.event === 'sessions') { this.activeSessions = message.value; this.emit('sessions', message.value); }
    else if (message.id) {
      const pending = this.pending.get(message.id); if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.value);
    }
  }
  call(method, payload) {
    if (!this.child || this.closing || this.exited) return Promise.reject(new Error('原生运行核心尚未就绪。'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('运行核心响应超时，结果未确认，请检查会话记录。')); }, method === 'launch' ? 60000 : 15000);
      timer.unref(); this.pending.set(id, { resolve, reject, timer });
      const message = { id, method, payload };
      try { this.child.postMessage ? this.child.postMessage(message) : this.child.send(message); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  snapshot() { return this.call('snapshot'); }
  engines() { return this.call('engines'); }
  send(payload) { return this.call('send', payload); }
  async launch(payload) {
    const result = await this.call('launch', payload);
    result.handles = result.handles.map(plan => this.startSession(plan));
    return result;
  }
  startSession(plan) {
    const child = this.spawn({ cwd: plan.cwd, env: { ...this.env, ...plan.env, AGENT_ROOM_SESSION: plan.instance_name }, serviceName: `Agent Room · ${plan.instance_name}` });
    const session = { child, chunks: [], bytes: 0, sequence: 0, alive: true, exitCode: null };
    this.sessions.set(plan.instance_name, session);
    child.on('message', message => {
      const event = message.value; if (!event) return;
      if (event.type === 'output') {
        const chunk = { sequence: ++session.sequence, data: event.data };
        session.chunks.push(chunk); session.bytes += Buffer.byteLength(event.data, 'base64');
        while (session.bytes > 2 * 1024 * 1024) session.bytes -= Buffer.byteLength(session.chunks.shift().data, 'base64');
        this.emit('terminal', { id: plan.instance_name, ...chunk });
      } else this.emit('terminal', { id: plan.instance_name, ...event });
    });
    child.on('exit', code => { session.alive = false; session.exitCode = code; this.emit('terminal', { id: plan.instance_name, type: 'exit', code }); this.updateSessions(); this.emit('session-exit', plan.instance_name); });
    this.postSession(session, { method: 'start', payload: plan }); this.updateSessions();
    return { tool: plan.tool, instance_name: plan.instance_name, embedded: true };
  }
  updateSessions() { this.activeSessions = [...this.sessions.values()].filter(s => s.alive).length; }
  getSession(id) { const s = this.sessions.get(id); if (!s) throw new Error('找不到应用托管的终端。'); return s; }
  postSession(session, message) { session.child.postMessage ? session.child.postMessage(message) : session.child.send(message); }
  terminal(id) { const s = this.getSession(id); return { chunks: s.chunks, sequence: s.sequence, alive: s.alive, exitCode: s.exitCode }; }
  input(id, data) { validateTerminalInput(data); return this.sessionCommand(id, 'input', { data }); }
  resize(id, cols, rows) { validateTerminalSize({ cols, rows }); return this.sessionCommand(id, 'resize', { cols, rows }); }
  stop(id) { return this.sessionCommand(id, 'stop', {}); }
  sessionCommand(id, method, payload) {
    const session = this.getSession(id); if (!session.alive) throw new Error('会话已经退出。');
    this.postSession(session, { method, payload }); return { accepted: true };
  }
  close() {
    if (this.closePromise) return this.closePromise;
    if (!this.child) return Promise.resolve();
    this.closing = true;
    this.closePromise = this.shutdown();
    return this.closePromise;
  }
  async shutdown() {
    try { await Promise.all([...this.sessions.values()].filter(s => s.alive).map(s => new Promise((resolve, reject) => {
      let timer, deadline; const done = () => { clearTimeout(timer); clearTimeout(deadline); resolve(); }; s.child.once('exit', done);
      this.postSession(s, { method: 'stop', payload: {} });
      timer = setTimeout(() => s.child.kill(), 4000);
      deadline = setTimeout(() => reject(new Error('托管进程未能在限定时间内退出。')), 8000);
    }))); } finally { this.child.kill(); }
  }
}
module.exports = { NativeRuntime };
