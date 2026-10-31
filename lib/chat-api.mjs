import { randomUUID } from 'node:crypto';
import { snapshotSchema, commandSchema, receiptSchema, clientError } from '../contracts/chat.mjs';
import { createChatProjection } from './chat-projection.mjs';
import { querySchema, queryResults } from '../contracts/settings.mjs';
import { createConnectionApi } from './connection-api.mjs';
import { createManagementApi } from './management-api.mjs';
import { createCapabilityApi } from './capability-api.mjs';
import { createTelemetryApi } from './telemetry-api.mjs';
import { createToolApi } from './tool-api.mjs';

// One server-side owner for the migration DTO, commands and snapshot subscription.
export function createChatApi(service) {
  const project = createChatProjection();
  const connections = createConnectionApi(service);
  const management = createManagementApi(service);
  const capabilities = createCapabilityApi(service), telemetry = createTelemetryApi(service);
  const tools = createToolApi(service);
  const listeners = new Set();
  const deciding = new Set();
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
    if (command.type === 'removeAttachment' || command.type === 'send' && command.attachmentIds?.length) throw clientError('unsupported', '附件需要持久后端。');
    if (['saveConnection', 'removeConnection'].includes(command.type)) return connections.execute(command);
    if (['createWorkspace', 'createRoom', 'setRoomMembers', 'launchAgent', 'stopAgent', 'removeAgent'].includes(command.type)) return management.execute(command);
    if (['saveCapabilityServer', 'importSkill', 'removeCapability', 'bindCapabilities'].includes(command.type)) return capabilities.execute(command);
    const view = snapshot();
    if (command.type === 'cancelRun') {
      const run = view.runs.find(r => r.id === command.runId);
      if (!run?.canCancel) throw clientError('not_running', '指定执行已结束或不能取消。');
      const agent = service.snapshot().agents.find(a => a.id === run.agentId);
      if (!agent?.rpc?.current || `run:${agent.id}:${agent.rpc.current.id}` !== run.id) throw clientError('not_running', '指定执行已变化。');
      await service.cancelSession(run.agentId, String(agent.rpc.current.id));
      return { accepted: true, operationId: randomUUID() };
    }
    if (command.type === 'decide') {
      const request = view.approvals.find(a => a.id === command.approvalId);
      if (!request) throw clientError('expired', '确认请求已失效。');
      if (request.revision !== command.expectedRevision) throw clientError('conflict', '确认请求已变化。');
      if (request.status !== 'pending' || request.delivery !== 'pending' || !request.allowedDecisions.includes(command.allow ? 'allow' : 'deny') || deciding.has(request.id)) throw clientError('decision_unavailable', '该请求不能重复处理。');
      if (command.allow && request.kind === 'questions' && request.questions.some((q, i) => !command.answers[i]?.some(v => v.trim()) || (!q.multiple && command.answers[i].length > 1))) throw clientError('invalid_answers', '请按问题要求提供有效回答。');
      if (command.allow && request.kind === 'input' && (!command.value.trim() || (request.options.length && !request.options.includes(command.value)))) throw clientError('invalid_answers', '请输入有效回答。');
      deciding.add(request.id);
      try {
        const result = await service.respondSession(request.agentId, request.id, { allow: command.allow, cancelled: !command.allow, scope: 'once', answers: command.answers, value: command.value });
        if (result?.delivery !== 'confirmed') throw clientError('decision_unknown', '答复已写入连接，但引擎未提供接收确认；不会重复提交。', 'unknown');
        return { accepted: true, operationId: randomUUID(), delivery: 'confirmed' };
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
        if (input?.type === 'query') {
          const parsed = querySchema.safeParse(input.query);
          if (!parsed.success) throw clientError('invalid_query', '查询不符合公开契约。');
          const handler = ({ catalog: management, capabilities, testCapabilityServer: capabilities, usage: telemetry, contexts: telemetry, toolDetails: tools })[parsed.data.type] || connections;
          return { ok: true, value: queryResults[parsed.data.type].parse(await handler.query(parsed.data)) };
        }
        return { ok: true, value: input?.type === 'snapshot' ? snapshot() : await execute(input) };
      } catch (error) {
        return { ok: false, error: { code: error.code || 'internal_error', message: error.code ? error.message : '聊天请求未能完成，请核查连接。', outcome: error.outcome || (['snapshot', 'query'].includes(input?.type) ? 'rejected' : 'unknown'), requestId } };
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
