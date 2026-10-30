import { randomUUID } from 'node:crypto';
import { snapshotSchema, commandSchema, receiptSchema, clientError } from '../contracts/chat.mjs';
import { createChatProjection } from './chat-projection.mjs';

// One server-side owner for the migration DTO, commands and snapshot subscription.
export function createChatApi(service) {
  const project = createChatProjection();
  const listeners = new Set();
  let closed = false;
  function snapshot(raw = service.snapshot()) {
    if (raw.connection !== 'connected') throw clientError('unavailable', '后端尚未连接。');
    return snapshotSchema.parse(project(raw));
  }
  function onState(raw) {
    let event;
    try { event = { type: 'snapshot', data: snapshot(raw) }; }
    catch { event = { type: 'offline' }; }
    for (const listener of listeners) listener(event);
  }
  service.on('state', onState);
  async function execute(input) {
    const parsed = commandSchema.safeParse(input);
    if (!parsed.success) throw clientError('invalid_command', '请求不符合聊天契约。');
    const command = parsed.data;
    const view = snapshot();
    if (command.type === 'decide') {
      const request = view.approvals.find(a => a.id === command.approvalId);
      if (!request) throw clientError('expired', '确认请求已失效。');
      if (request.revision !== command.expectedRevision) throw clientError('conflict', '确认请求已变化。');
      try {
        await service.respondSession(request.agentId, request.id, { allow: command.allow, cancelled: !command.allow, scope: 'once', answers: command.answers, value: command.value });
        return { accepted: true, operationId: randomUUID() };
      } catch { throw clientError('decision_unknown', '答复投递结果未确认，请核查会话。', 'unknown'); }
    }
    if (command.mode === 'task') throw clientError('unsupported', '当前后端尚未支持任务负责人，请使用讨论。');
    const room = view.rooms.find(r => r.id === command.roomId);
    if (!room) throw clientError('not_found', '会话不存在。');
    if (command.mentions.some(m => !room.memberIds.includes(m.agentId) || command.text.slice(m.start, m.end) !== `@${view.agents.find(a => a.id === m.agentId)?.name}`)) {
      throw clientError('invalid_mentions', '提及已变化，请重新选择成员。');
    }
    const recipientIds = command.mentions.length ? [...new Set(command.mentions.map(m => m.agentId))] : undefined;
    const result = await service.send({ roomId: room.id, text: command.text, recipientIds });
    return receiptSchema.parse({ accepted: true, operationId: result.receipt?.event_id ? `message:${result.receipt.event_id}` : randomUUID() });
  }
  return {
    async request(input) {
      const requestId = randomUUID();
      try {
        if (closed) throw clientError('unavailable', '聊天连接已关闭。');
        return { ok: true, value: input?.type === 'snapshot' ? snapshot() : await execute(input) };
      } catch (error) {
        return { ok: false, error: { code: error.code || 'internal_error', message: error.code ? error.message : '聊天请求未能完成，请核查连接。', outcome: error.outcome || 'unknown', requestId } };
      }
    },
    subscribe(listener) {
      if (closed) throw clientError('unavailable', '聊天连接已关闭。');
      // Register before reading. Both operations are synchronous with service state events.
      listeners.add(listener);
      try { listener({ type: 'snapshot', data: snapshot() }); }
      catch { listener({ type: 'offline' }); }
      return () => listeners.delete(listener);
    },
    close() { closed = true; service.off('state', onState); listeners.clear(); },
  };
}
