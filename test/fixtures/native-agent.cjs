// Deterministic CLI fixture: exercises real hcom hooks/notify/read/ack/send and
// ConPTY, without invoking a model or modifying real CLI configuration.
const { execFileSync } = require('node:child_process');
const net = require('node:net');
const helper = process.env.AGENT_ROOM_HCOM_HELPER;
const name = process.env.HCOM_INSTANCE_NAME;
function rpc(args) {
  const result = execFileSync(helper, args, { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const value = JSON.parse(result); if (value.error) throw new Error(value.error); return value;
}
const server = net.createServer(socket => { socket.end(); read(); });
let reading = false;
function read() {
  if (reading) return; reading = true;
  try {
    const batch = rpc(['pi-read', '--name', name]);
    for (const message of batch.messages) {
      if (message.from === 'user') rpc(['send', '--json', '--intent', 'inform', '--thread', message.thread || 'native-check', '--', `fixture-reply:${message.message}`]);
    }
    if (batch.messages.length) rpc(['pi-read', '--name', name, '--ack', '--up-to', String(batch.messages.at(-1).event_id)]);
  } catch (error) { process.stdout.write(`RPC-ERROR:${error.message}\r\n`); }
  finally { reading = false; }
}
server.listen(0, '127.0.0.1', () => {
  rpc(['pi-start', '--session-id', `fixture-${name}`, '--cwd', process.cwd(), '--notify-port', String(server.address().port)]);
  process.stdout.write(`NATIVE-READY:${name}:${process.cwd()}\r\n`);
});
process.stdin.setRawMode?.(true); process.stdin.resume();
let line = '';
process.stdin.on('data', bytes => {
  for (const char of bytes.toString('utf8')) {
    if (char === '\r' || char === '\n') {
      if (line.startsWith('peer:')) rpc(['send', '--json', `@${line.slice(5)}`, '--intent', 'inform', '--thread', 'native-peer', '--', `peer-from:${name}`]);
      else process.stdout.write(`NATIVE-ECHO:${line}\r\n`);
      line = '';
    } else if (char !== '\x03') line += char;
  }
});
setInterval(read, 1000).unref();
