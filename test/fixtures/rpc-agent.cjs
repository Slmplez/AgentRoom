const http = require('node:http');
const { Lines } = require('../../lib/rpc/transport.cjs');
if (process.stdin.isTTY || process.stdout.isTTY) throw new Error('Fixture requires pipes, not a PTY');
const tool = process.env.RPC_FIXTURE_TOOL;
const send = record => process.stdout.write(JSON.stringify(record) + '\n');
let count = 0, waiting;
function finish(text = 'fixture reply 你好\u2028continued') {
  if (tool === 'codex') { send({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'a', delta: text } }); send({ method: 'item/completed', params: { item: { id: 'a', type: 'agentMessage', text } } }); send({ method: 'turn/completed', params: { turn: { status: 'completed' } } }); }
  if (tool === 'pi') { send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }] } }); send({ type: 'agent_end' }); setTimeout(() => send({ type: 'agent_settled' }), 35); }
  if (tool === 'claude') { send({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text }] } }); send({ type: 'result', result: text, is_error: false }); }
}
if (tool !== 'opencode') {
  const lines = new Lines(line => {
    const m = JSON.parse(line);
    if (JSON.stringify(m).includes('crash-fixture')) return process.exit(17);
    if (tool === 'codex') {
      if (m.method === 'initialize') return send({ id: m.id, result: {} });
      if (m.method === 'thread/start') return send({ id: m.id, result: { thread: { id: 'thread-1' } } });
      if (m.method === 'turn/start') {
        send({ id: m.id, result: { turn: { id: 'turn-' + ++count } } });
        if (m.params.input[0].text.includes('approve')) { waiting = true; return send({ id: 900, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', command: 'fixture safe operation' } }); }
        if (m.params.input[0].text.includes('wait')) return;
        return finish();
      }
      if (m.method === 'turn/interrupt') { send({ id: m.id, result: {} }); return finish('interrupted'); }
      if (waiting && m.id === 900) { waiting = false; return finish(m.result.decision); }
    }
    if (tool === 'pi') {
      if (m.type === 'get_state') return send({ id: m.id, type: 'response', success: true, data: {} });
      if (m.type === 'prompt') {
        send({ id: m.id, type: 'response', success: true, data: { disposition: 'started' } });
        if (m.message.includes('approve')) return send({ type: 'extension_ui_request', method: 'confirm', id: '900', title: 'fixture permission' });
        if (m.message.includes('wait')) return;
        return finish();
      }
      if (m.type === 'extension_ui_response') return finish(String(m.confirmed));
      if (m.type === 'abort') { send({ id: m.id, type: 'response', success: true }); return finish('interrupted'); }
    }
    if (tool === 'claude') {
      if (m.type === 'control_request') {
        send({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, response: {} } });
        if (m.request.subtype === 'interrupt') return finish('interrupted');
      }
      if (m.type === 'user') {
        if (m.message.content[0].text.includes('approve')) return send({ type: 'control_request', request_id: '900', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'fixture safe operation' } } });
        if (m.message.content[0].text.includes('wait')) return;
        return finish();
      }
      if (m.type === 'control_response') return finish(m.response.response.behavior);
    }
  });
  process.stdin.on('data', b => lines.push(b)); process.stdin.on('end', () => process.exit());
} else {
  let stream;
  const event = (type, properties) => stream?.write('data: ' + JSON.stringify({ type, properties: { sessionID: 'ses_fixture', ...properties } }) + '\n\n');
  const complete = text => { event('message.part.updated', { part: { type: 'text', id: 'part-1', messageID: 'assistant', text } }); event('session.idle', {}); };
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64')) { res.writeHead(401); return res.end(); }
    const url = new URL(req.url, 'http://localhost');
    if (!url.searchParams.get('directory')) { res.writeHead(400); return res.end('directory missing'); }
    if (url.pathname === '/event') { stream = res; res.writeHead(200, { 'Content-Type': 'text/event-stream' }); res.write('data: {"type":"server.connected","properties":{}}\n\n'); return; }
    let raw = ''; for await (const b of req) raw += b; const data = raw ? JSON.parse(raw) : {};
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname === '/session') return res.end('{"id":"ses_fixture"}');
    if (url.pathname.endsWith('/prompt_async')) {
      res.writeHead(204); res.end();
      const text = data.parts[0].text;
      event('message.updated', { info: { id: 'user', role: 'user' } });
      event('message.part.updated', { part: { type: 'text', id: 'user-part', messageID: 'user', text } });
      if (text.includes('approve')) return event('permission.asked', { id: 'per_fixture', permission: 'bash', patterns: ['fixture safe operation'] });
      if (text.includes('wait')) return;
      return complete('fixture reply 你好\u2028continued');
    }
    res.end('true');
    if (url.pathname.includes('/permission/')) complete(data.reply);
    if (url.pathname.endsWith('/abort')) complete('interrupted');
  });
  server.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1', () => console.log('opencode server listening on http://127.0.0.1:' + server.address().port));
  process.stdin.resume(); process.stdin.on('end', () => { server.closeAllConnections(); server.close(() => process.exit()); });
}
