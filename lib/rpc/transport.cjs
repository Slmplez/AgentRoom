const { EventEmitter } = require('node:events');
const { StringDecoder } = require('node:string_decoder');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');

// Strict LF framing preserves U+2028/U+2029 inside JSON strings and split UTF-8 bytes.
class Lines {
  constructor(onLine, limit = 16 * 1024 * 1024) { this.decoder = new StringDecoder('utf8'); this.buffer = ''; this.onLine = onLine; this.limit = limit; }
  push(bytes) {
    this.buffer += this.decoder.write(bytes);
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      if (Buffer.byteLength(this.buffer.slice(0, end)) > this.limit) throw new Error('RPC record exceeds limit');
      const line = this.buffer.slice(0, end).replace(/\r$/, ''); this.buffer = this.buffer.slice(end + 1); this.onLine(line);
    }
    if (Buffer.byteLength(this.buffer) > this.limit) throw new Error('RPC record exceeds limit');
  }
}

async function resolveCommand(tool, env) {
  const dirs = (Object.entries(env).find(([k]) => k.toUpperCase() === 'PATH')?.[1] || '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const file = path.join(dir, process.platform === 'win32' ? `${tool}.exe` : tool);
    try { await fs.access(file); return { command: file, args: [] }; } catch {}
  }
  const packages = { codex: '@openai/codex', claude: '@anthropic-ai/claude-code', pi: '@earendil-works/pi-coding-agent', opencode: 'opencode-ai' };
  for (const dir of dirs) {
    const root = path.join(dir, 'node_modules', packages[tool] || tool);
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
      const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.[tool];
      if (!bin) continue;
      const target = path.join(root, bin); await fs.access(target);
      return /\.exe$/i.test(target) ? { command: target, args: [] } : { command: process.execPath, args: [target] };
    } catch {}
  }
  throw new Error(`未找到 ${tool} 可直接运行的程序。RPC 不会回退到终端或 shell。`);
}

class Pipe extends EventEmitter {
  constructor(options) { super(); this.options = options; this.pending = new Map(); this.counter = 0; this.stderr = ''; this.writes = Promise.resolve(); }
  async start(args, json = true) {
    if (this.closing) throw new Error('RPC 会话正在关闭');
    const o = this.options, bin = o.command || await resolveCommand(o.tool, o.env);
    if (this.closing) throw new Error('RPC 会话正在关闭');
    const env = { ...o.env, ELECTRON_RUN_AS_NODE: '1', NO_COLOR: '1' };
    const inheritedBypass = Object.entries(env).find(([k]) => k.toUpperCase() === 'NO_PROXY')?.[1] || '';
    for (const k of Object.keys(env)) if (k.toUpperCase() === 'NO_PROXY') delete env[k];
    env.NO_PROXY = [inheritedBypass, '127.0.0.1', 'localhost', '::1'].filter(Boolean).join(',');
    if (process.platform !== 'win32') env.no_proxy = env.NO_PROXY;
    this.child = (o.spawn || spawn)(bin.command, [...bin.args, ...args], {
      cwd: o.directory, env,
      shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    const lines = new Lines(line => {
      if (!line.trim()) return;
      try { this.emit('record', json ? JSON.parse(line) : line); } catch (e) { this.fail(e); }
    });
    this.child.stdout.on('data', bytes => { try { lines.push(bytes); } catch (e) { this.fail(e); } });
    this.child.stderr.on('data', bytes => { this.stderr = (this.stderr + bytes.toString()).slice(-12000); });
    this.child.stdin.on('error', e => this.fail(e));
    this.child.on('error', e => this.fail(e));
    this.child.on('exit', (code, signal) => {
      this.exited = true;
      let diagnostic = this.stderr.slice(-2000);
      for (const [key, value] of Object.entries(o.env)) if (/key|token|password|secret|auth/i.test(key) && typeof value === 'string' && value.length > 6) diagnostic = diagnostic.replaceAll(value, '[redacted]');
      const error = new Error(`${o.tool} RPC 进程退出 (${code ?? signal})${diagnostic ? ': ' + diagnostic : ''}`);
      this.rejectPending(error); if (!this.closing) this.emit('failure', error);
      this.emit('exit', { code, signal });
    });
    return this;
  }
  fail(error) { if (this.failed || this.closing) return; this.failed = true; this.rejectPending(error); this.emit('failure', error); this.child?.kill(); }
  rejectPending(error) { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); }
  write(record) {
    const task = this.writes.then(async () => {
      if (this.exited || this.failed || this.closing) throw new Error('RPC 管道已关闭');
      await new Promise((resolve, reject) => this.child.stdin.write(JSON.stringify(record) + '\n', e => e ? reject(e) : resolve()));
    });
    this.writes = task.catch(() => {}); return task;
  }
  request(record, id = String(++this.counter), timeout = 60000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(String(id)); const error = new Error('RPC 请求超时，执行结果未知；没有自动重试。'); error.uncertain = true; reject(error); }, timeout);
      this.pending.set(String(id), { resolve, reject, timer });
      this.write(record(id)).catch(e => this.settle(id, null, e));
    });
  }
  settle(id, value, error) { const p = this.pending.get(String(id)); if (!p) return false; clearTimeout(p.timer); this.pending.delete(String(id)); error ? p.reject(error) : p.resolve(value); return true; }
  async close() {
    if (this.closePromise) return this.closePromise;
    this.closing = true; this.rejectPending(new Error('会话已停止'));
    this.closePromise = new Promise(resolve => {
      if (!this.child || this.exited) return resolve();
      const child = this.child;
      let force, deadline;
      const done = () => { clearTimeout(force); clearTimeout(deadline); resolve(); };
      child.once('exit', done); child.stdin.end();
      force = setTimeout(() => {
        if (process.platform === 'win32' && child.pid) {
          // Target only the process owned by this transport and its tool children.
          const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill());
        } else child.kill();
      }, 1500);
      deadline = setTimeout(done, 4000);
    });
    return this.closePromise;
  }
}
module.exports = { Lines, Pipe, resolveCommand };
