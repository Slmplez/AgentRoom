// Runs in an Electron utility process. Each PTY gets another utility process so
// upstream process-level identities and delivery globals cannot cross sessions.
const { validateTerminalInput, validateTerminalSize } = require('./terminal-contract.cjs');
const port = process.parentPort;
const post = message => port ? port.postMessage(message) : process.send?.(message);
const listen = callback => port ? port.on('message', event => callback(event.data)) : process.on('message', callback);
const native = require(process.env.AGENT_ROOM_NATIVE_MODULE);
if (process.env.AGENT_ROOM_SESSION) {
  native.initialize();
  listen(message => {
    try {
      const p = message.payload;
      if (message.method === 'start') native.startSession(p.tool, p.args, json => {
        const value = JSON.parse(json); post({ event: 'terminal', value });
        if (value.type === 'exit') setTimeout(() => process.exit(value.code || 0), 100);
      });
      if (message.method === 'input') native.writeInput(Buffer.from(validateTerminalInput(p.data), 'utf8'));
      if (message.method === 'resize') { const { cols, rows } = validateTerminalSize(p); native.resize(cols, rows); }
      if (message.method === 'stop') native.stop();
    } catch (error) { post({ event: 'terminal', value: { type: 'error', message: error.message } }); }
  });
} else {
  const methods = {
    initialize() {
      if (typeof native.rpcRegister !== 'function') throw new Error('原生核心版本过旧，请运行 npm run build:native 后重启应用');
      const version = JSON.parse(native.initialize());
      native.watch(json => post({ event: 'state', value: JSON.parse(json) }));
      return version;
    },
    snapshot: () => JSON.parse(native.snapshot()),
    engines: () => JSON.parse(native.engines()),
    send: p => JSON.parse(native.send(JSON.stringify(p))),
    launch: p => JSON.parse(native.prepareLaunch(JSON.stringify(p))),
    rpcRegister: p => JSON.parse(native.rpcRegister(JSON.stringify(p))),
    rpcUpdate: p => JSON.parse(native.rpcUpdate(JSON.stringify(p))),
    rpcInbox: p => JSON.parse(native.rpcInbox(p.name)),
    rpcAck: p => JSON.parse(native.rpcAck(JSON.stringify(p))),
    rpcReply: p => JSON.parse(native.rpcReply(JSON.stringify(p))),
  };
  listen(async message => {
    try {
      if (!Object.hasOwn(methods, message.method)) throw new Error('Unsupported runtime method');
      post({ id: message.id, value: await methods[message.method](message.payload) });
    } catch (error) { post({ id: message.id, error: error.message }); }
  });
}
