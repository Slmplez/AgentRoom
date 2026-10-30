import { snapshotSchema, receiptSchema, errorSchema, clientError } from '../../contracts/chat.mjs';

export function createChatTransport(channel) {
  async function request(input, schema) {
    let result;
    try { result = await channel.request(input); }
    catch { throw clientError('transport_unavailable', '无法确认请求结果，请核查连接和会话记录。', input.type === 'snapshot' ? 'rejected' : 'unknown'); }
    if (result?.ok === false) {
      const parsed = errorSchema.safeParse(result.error);
      if (!parsed.success) throw clientError('invalid_response', '服务端响应不符合聊天契约。', input.type === 'snapshot' ? 'rejected' : 'unknown');
      const error = parsed.data;
      throw Object.assign(clientError(error.code, error.message, error.outcome), { requestId: error.requestId });
    }
    if (result?.ok !== true) throw clientError('invalid_response', '服务端响应不符合聊天契约。', input.type === 'snapshot' ? 'rejected' : 'unknown');
    const parsed = schema.safeParse(result.value);
    if (!parsed.success) throw clientError('invalid_response', '服务端响应不符合聊天契约。', input.type === 'snapshot' ? 'rejected' : 'unknown');
    return parsed.data;
  }
  return { snapshot: () => request({ type: 'snapshot' }, snapshotSchema), command: command => request(command, receiptSchema), subscribe: listener => channel.subscribe(listener) };
}

export function createHttpChannel({ baseUrl = '', fetch: fetcher = globalThis.fetch, EventSource: Stream = globalThis.EventSource } = {}) {
  return {
    async request(input) {
      const reading = input.type === 'snapshot';
      const response = await fetcher(`${baseUrl}/api/chat/${reading ? 'snapshot' : 'commands'}`, {
        method: reading ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: reading ? undefined : JSON.stringify(input), signal: AbortSignal.timeout(30000),
      });
      return response.json();
    },
    subscribe(listener) {
      const stream = new Stream(`${baseUrl}/api/chat/events`);
      stream.onmessage = event => { try { listener(JSON.parse(event.data)); } catch { listener({ type: 'offline' }); } };
      stream.onerror = () => listener({ type: 'offline' });
      return () => stream.close();
    },
  };
}
