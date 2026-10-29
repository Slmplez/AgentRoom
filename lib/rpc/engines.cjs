const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const net = require('node:net');
const { Pipe, Lines } = require('./transport.cjs');

const textOf = message => (message?.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
class Engine extends EventEmitter {
  constructor(options) {
    super(); this.options = options; this.requests = new Map();
    this.pipe = new Pipe(options);
    this.pipe.on('failure', e => this.fail(e));
    this.pipe.on('exit', e => this.emit('exit', e));
  }
  begin() {
    if (this.turn) throw new Error('RPC 会话正在处理上一条消息');
    this.parts = new Map(); this.turnError = null;
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    // Events can complete before the command acknowledgement arrives.
    promise.catch(() => {}); this.turn = { resolve, reject, promise }; return promise;
  }
  finish(error) {
    const turn = this.turn; if (!turn) return; this.turn = null;
    this.requests.clear(); this.emit('requests-cleared');
    error ||= this.turnError;
    error ? turn.reject(error) : turn.resolve([...this.parts.values()].join('\n\n'));
  }
  fail(error) { this.failure = error; this.finish(error); this.emit('failure', error); }
  approval(id, kind, data) { const r = { id: String(id), wireId: id, kind, data }; this.requests.set(String(id), r); this.emit('approval', r); }
  activity(kind, detail) { this.emit('activity', { kind, detail }); }
  part(id, text, delta = false) { this.parts.set(id, delta ? (this.parts.get(id) || '') + text : text); this.emit('delta', { text: [...this.parts.values()].join('\n\n') }); }
  async close() { this.finish(new Error('会话已停止')); await this.pipe.close(); }
  get pid() { return this.pipe.child?.pid; }
}

class Codex extends Engine {
  request(method, params) { return this.pipe.request(id => ({ id, method, params })); }
  async start() {
    this.pipe.on('record', m => {
      if (m.id !== undefined && !m.method) return this.pipe.settle(m.id, m.result, m.error && new Error(m.error.message));
      const p = m.params || {};
      if (m.id !== undefined) {
        if (/requestApproval$/.test(m.method)) return this.approval(m.id, 'permission', { method: m.method, ...p });
        if (m.method === 'item/tool/requestUserInput') return this.approval(m.id, 'questions', { method: m.method, ...p });
        this.pipe.write({ id: m.id, error: { code: -32601, message: 'Unsupported client request' } }).catch(e => this.fail(e)); return;
      }
      if (m.method === 'serverRequest/resolved') { this.requests.delete(String(p.requestId)); this.emit('requests-cleared'); }
      if (p.threadId && this.threadId && p.threadId !== this.threadId) return;
      if (m.method === 'item/agentMessage/delta') this.part(p.itemId, p.delta, true);
      if (m.method === 'item/completed' && p.item?.type === 'agentMessage') this.part(p.item.id, p.item.text);
      if (m.method === 'item/started' && p.item?.type !== 'agentMessage') this.activity(p.item?.type, p.item?.command || '');
      if (m.method === 'turn/completed') this.finish(p.turn?.status === 'failed' ? new Error(p.turn.error?.message || 'Codex turn failed') : undefined);
    });
    await this.pipe.start([...(this.options.args || []), 'app-server']);
    await this.request('initialize', { clientInfo: { name: 'agent_room', title: 'Agent Room', version: '0.1.0' } });
    await this.pipe.write({ method: 'initialized', params: {} });
    const r = await this.request('thread/start', { cwd: this.options.directory, approvalPolicy: 'on-request', sandbox: 'workspace-write', developerInstructions: this.options.instructions });
    this.threadId = r.thread.id;
  }
  async prompt(text) {
    const done = this.begin();
    try { const r = await this.request('turn/start', { threadId: this.threadId, input: [{ type: 'text', text }] }); this.turnId = r.turn.id; }
    catch (e) { this.finish(e); }
    return done;
  }
  cancel() { return this.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }); }
  async respond(id, answer) {
    const r = this.requests.get(String(id)); if (!r) throw new Error('确认请求已失效');
    let result;
    if (r.kind === 'questions') result = { answers: answer.cancelled ? {} : Object.fromEntries((r.data.questions || []).map((q, i) => [q.id, { answers: answer.answers?.[i] || [] }])) };
    else if (r.data.method === 'item/permissions/requestApproval') result = { permissions: answer.allow ? r.data.permissions : {}, scope: 'turn' };
    else result = { decision: answer.allow ? 'accept' : 'decline' };
    await this.pipe.write({ id: r.wireId, result }); this.requests.delete(String(id));
  }
}

class Pi extends Engine {
  request(type, fields = {}) { return this.pipe.request(id => ({ id, type, ...fields })); }
  async start() {
    this.pipe.on('record', m => {
      if (m.type === 'response') return this.pipe.settle(m.id, m.data, !m.success && new Error(m.error));
      if (m.type === 'message_update' && m.assistantMessageEvent?.type === 'text_delta') this.part('text', m.assistantMessageEvent.delta, true);
      if (m.type === 'message_start' && m.message?.role === 'assistant') this.current = String((this.current || 0) + 1);
      if (m.type === 'message_end' && m.message?.role === 'assistant') {
        this.parts.delete('text'); this.part(this.current || 'final', textOf(m.message));
        if (m.message.stopReason === 'error') this.turnError = new Error(m.message.errorMessage || 'Pi provider failed');
      }
      if (m.type === 'tool_execution_start') this.activity(m.toolName, JSON.stringify(m.args || {}));
      if (m.type === 'agent_settled') this.finish();
      if (m.type === 'extension_ui_request') {
        if (['select', 'confirm', 'input', 'editor'].includes(m.method)) this.approval(m.id, m.method === 'confirm' ? 'permission' : 'input', m);
        else this.activity(m.method, m.message || m.text || '');
      }
    });
    await this.pipe.start(['--mode', 'rpc', '--no-session', '--append-system-prompt', this.options.instructions || '', ...(this.options.args || [])]);
    const state = await this.request('get_state'); this.sessionId = state?.sessionId;
  }
  async prompt(message) {
    const done = this.begin();
    try { const r = await this.request('prompt', { message }); if (r?.disposition === 'handled') this.finish(); }
    catch (e) { this.finish(e); }
    return done;
  }
  cancel() { return this.request('abort'); }
  async respond(id, answer) {
    const r = this.requests.get(String(id)); if (!r) throw new Error('确认请求已失效');
    await this.pipe.write({ type: 'extension_ui_response', id, ...(r.data.method === 'confirm' ? { confirmed: Boolean(answer.allow) } : answer.cancelled ? { cancelled: true } : { value: answer.value || '' }) });
    this.requests.delete(String(id));
  }
}

class Claude extends Engine {
  request(request) { return this.pipe.request(id => ({ type: 'control_request', request_id: id, request })); }
  async start() {
    this.pipe.on('record', m => {
      if (m.session_id) this.sessionId = m.session_id;
      if (m.type === 'control_response') { const r = m.response; return this.pipe.settle(r.request_id, r.response, r.subtype === 'error' && new Error(r.error)); }
      if (m.type === 'control_request') {
        if (m.request.subtype === 'can_use_tool') this.approval(m.request_id, m.request.tool_name === 'AskUserQuestion' ? 'questions' : 'permission', m.request);
        else this.pipe.write({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: 'Unsupported client request' } }).catch(e => this.fail(e));
      }
      if (m.type === 'control_cancel_request') { this.requests.delete(m.request_id); this.emit('requests-cleared'); }
      if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta') this.part('stream', m.event.delta.text, true);
      if (m.type === 'assistant') {
        this.parts.delete('stream'); this.part(m.message.id, textOf(m.message));
        for (const p of m.message.content || []) if (p.type === 'tool_use') this.activity(p.name, JSON.stringify(p.input));
      }
      if (m.type === 'result') { if (!this.parts.size && m.result) this.part('result', m.result); this.finish(m.is_error ? new Error(m.errors?.join('\n') || m.result || 'Claude turn failed') : undefined); }
    });
    await this.pipe.start(['--print', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--permission-prompt-tool', 'stdio', '--append-system-prompt', this.options.instructions || '', ...(this.options.args || [])]);
    await this.request({ subtype: 'initialize', hooks: null });
  }
  async prompt(text) {
    const done = this.begin();
    try { await this.pipe.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] }, parent_tool_use_id: null, session_id: '' }); } catch (e) { this.finish(e); }
    return done;
  }
  cancel() { return this.request({ subtype: 'interrupt' }); }
  async respond(id, answer) {
    const r = this.requests.get(String(id)); if (!r) throw new Error('确认请求已失效');
    let updatedInput = r.data.input;
    if (r.kind === 'questions') updatedInput = { ...updatedInput, answers: Object.fromEntries((r.data.input?.questions || []).map((q, i) => [q.question, (answer.answers?.[i] || []).join(', ')])) };
    await this.pipe.write({ type: 'control_response', response: { subtype: 'success', request_id: id, response: answer.allow && !answer.cancelled ? { behavior: 'allow', updatedInput } : { behavior: 'deny', message: 'Denied in Agent Room' } } });
    this.requests.delete(String(id));
  }
}

async function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); }); }
class OpenCode extends Engine {
  async http(route, body, signal) {
    const url = new URL(route, this.url); url.searchParams.set('directory', this.options.directory);
    const r = await fetch(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', headers: { Authorization: this.auth, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: signal || AbortSignal.timeout(60000) });
    if (!r.ok) throw new Error(`OpenCode RPC ${r.status}: ${(await r.text()).slice(0, 500)}`);
    return r;
  }
  async start() {
    const port = await freePort(), password = randomBytes(32).toString('hex');
    this.userMessages = new Set();
    this.url = `http://127.0.0.1:${port}`; this.auth = 'Basic ' + Buffer.from(`opencode:${password}`).toString('base64');
    this.pipe.options.env = { ...this.options.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' };
    let resolve; const ready = new Promise(r => { resolve = r; });
    this.pipe.on('record', line => { if (line.includes(this.url)) resolve(); });
    await this.pipe.start(['serve', '--hostname', '127.0.0.1', '--port', String(port), ...(this.options.serverArgs || [])], false);
    let timer; try { await Promise.race([ready, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('OpenCode server 启动超时')), 60000); this.pipe.once('failure', reject); })]); } finally { clearTimeout(timer); }
    const session = await (await this.http('/session', { title: 'Agent Room' })).json(); this.sessionId = session.id;
    this.streamAbort = new AbortController();
    const stream = await this.http('/event', undefined, this.streamAbort.signal);
    this.readEvents(stream).catch(e => { if (!this.closing) this.fail(e); });
  }
  async readEvents(response) {
    let data = [];
    const lines = new Lines(line => {
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
      else if (!line && data.length) { const record = JSON.parse(data.join('\n')); data = []; this.event(record); }
    });
    for await (const bytes of response.body) lines.push(bytes);
    if (!this.closing) throw new Error('OpenCode SSE 已断开，执行结果未知；没有自动重放。');
  }
  event(m) {
    const p = m.properties || {};
    if (p.sessionID && p.sessionID !== this.sessionId) return;
    if (m.type === 'message.part.delta' && p.field === 'text' && this.turn && !this.userMessages.has(p.messageID)) this.part(p.partID, p.delta, true);
    if (m.type === 'message.part.updated') {
      const part = p.part;
      if (part.type === 'text' && !part.synthetic && this.turn && !this.userMessages.has(part.messageID)) this.part(part.id, part.text);
      if (part.type === 'tool') this.activity(part.tool, JSON.stringify(part.state?.input || {}));
    }
    if (m.type === 'message.updated' && p.info?.role === 'user') this.userMessages.add(p.info.id);
    if (m.type === 'permission.asked') this.approval(p.id, 'permission', p);
    if (m.type === 'question.asked') this.approval(p.id, 'questions', p);
    if (['permission.replied', 'question.replied', 'question.rejected'].includes(m.type)) { this.requests.delete(String(p.requestID)); this.emit('requests-cleared'); }
    if (m.type === 'session.error') this.turnError = new Error(p.error?.data?.message || p.error?.message || 'OpenCode provider failed');
    if (m.type === 'session.idle' || m.type === 'session.status' && p.status?.type === 'idle') this.finish();
  }
  async prompt(text) {
    const done = this.begin(); this.userMessages ||= new Set();
    try { await this.http(`/session/${encodeURIComponent(this.sessionId)}/prompt_async`, { parts: [{ type: 'text', text }], system: this.options.instructions }); } catch (e) { e.uncertain = true; this.finish(e); }
    return done;
  }
  cancel() { return this.http(`/session/${encodeURIComponent(this.sessionId)}/abort`, {}); }
  async respond(id, answer) {
    const r = this.requests.get(String(id)); if (!r) throw new Error('确认请求已失效');
    await this.http(r.kind === 'questions' ? `/question/${encodeURIComponent(id)}/${answer.cancelled ? 'reject' : 'reply'}` : `/permission/${encodeURIComponent(id)}/reply`, r.kind === 'questions' ? answer.cancelled ? {} : { answers: answer.answers || [] } : { reply: answer.allow ? 'once' : 'reject' });
    this.requests.delete(String(id));
  }
  async close() { this.closing = true; this.streamAbort?.abort(); await super.close(); }
}
const ENGINES = { codex: Codex, claude: Claude, pi: Pi, opencode: OpenCode };
function createEngine(options) { const Type = ENGINES[options.tool]; if (!Type) throw new Error('该引擎尚无 RPC 适配器'); return new Type(options); }
module.exports = { createEngine, Codex, Pi, Claude, OpenCode };
