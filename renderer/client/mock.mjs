import { commandSchema, clientError } from '../../contracts/chat.mjs';
import { createMockSettings } from './mock-settings.mjs';
import { createMockAdmin } from './mock-admin.mjs';
import { createMockQuestions } from './mock-questions.mjs';
import { createMockArtifacts } from './mock-artifacts.mjs';

const stamp = '2026-10-30T08:00:00.000Z';
const samplePatch = 'diff --git a/welcome.ts b/welcome.ts\n--- a/welcome.ts\n+++ b/welcome.ts\n@@ -1 +1 @@\n-export const title = "Hello";\n+export const title = "一起完成下一件事";\n';
function initial(instanceId) {
  return {
    instanceId, revision: 0, capabilities: { tasks: true, idempotentSend: true, collaborationQuestions: true, questionAdvice: true }, currentUserId: 'user', questions: [],
    workspaces: [{ id: 'workspace-demo', title: 'Agent Room', directory: '模拟工作区 · 不访问本机文件' }],
    agents: [
      { id: 'alpha', name: 'alpha', displayName: 'Alpha', engine: 'Codex', status: 'listening', workspaceId: 'workspace-demo' },
      { id: 'beta', name: 'beta', displayName: 'Beta', engine: 'Claude', status: 'listening', workspaceId: 'workspace-demo' },
      { id: 'gamma', name: 'gamma', displayName: 'Gamma', engine: 'Pi', status: 'listening', workspaceId: 'workspace-demo' },
    ],
    rooms: [
      { id: 'room-design', title: '产品与设计', type: 'group', workspaceId: 'workspace-demo', memberIds: ['alpha', 'beta', 'gamma'], ownerAgentId: 'alpha' },
      { id: 'room-code', title: '代码审阅', type: 'group', workspaceId: 'workspace-demo', memberIds: ['alpha', 'beta'], ownerAgentId: 'beta' },
      ...['alpha', 'beta', 'gamma'].map(id => ({ id: `dm:${id}`, title: id[0].toUpperCase() + id.slice(1), type: 'dm', workspaceId: 'workspace-demo', memberIds: [id], ownerAgentId: id })),
    ],
    messages: [
      { id: 'welcome-user', roomId: 'room-design', sequence: 1, role: 'user', authorId: 'user', authorName: '你', text: '保留现有设计，让消息和操作更清楚。', status: 'complete', createdAt: stamp, tools: [] },
      { id: 'welcome-alpha', roomId: 'room-design', sequence: 2, role: 'assistant', authorId: 'alpha', authorName: 'Alpha', text: '我们先让每一步都清楚。\n\n- 正文保留完整的阅读空间\n- 工具过程默认收起，需要时再展开\n- 重要操作统一等待你的确认\n\n可以输入 `@` 选择参与者，或者切换到单个 Agent 继续。', status: 'complete', createdAt: stamp, tools: [] },
    ], approvals: [], approvalHistory: [], runs: [],
  };
}

// Deliberately has no backend, filesystem, model, or credential imports.
export function createMockTransport({ manual = false } = {}) {
  let incarnation = 1, state = initial('mock-1'), online = true, sequence = 2, requestNumber = 0, timer, paused = false, elapsed = 0;
  const listeners = new Set(), receipts = new Map(), pending = new Map();
  const settings = createMockSettings();
  const toolDetails = new Map();
  const admin = createMockAdmin(() => state, publish);
  const questions = createMockQuestions(() => state, publish, message);
  const artifacts = createMockArtifacts(() => state, publish, message);
  let holdSnapshots = false, decisionUnknown = false;
  const delayedSnapshots = [];
  const emit = event => { for (const listener of listeners) listener(event); };
  const snapshot = () => structuredClone(state);
  function publish() { state.revision++; if (online) emit({ type: 'snapshot', data: snapshot() }); }
  function message(roomId, authorId, text, status = 'complete') {
    const agent = state.agents.find(a => a.id === authorId);
    const m = { id: `mock-${incarnation}-${++sequence}`, roomId, sequence, authorId, authorName: agent?.displayName || '你', role: agent ? 'assistant' : 'user', text, status, createdAt: new Date(Date.parse(stamp) + elapsed).toISOString(), tools: [] };
    state.messages.push(m); return m;
  }
  function advance(milliseconds = 650) {
    if (paused) return;
    elapsed += milliseconds;
    for (const [id, job] of pending) {
      const m = state.messages.find(item => item.id === id);
      if (!m) { pending.delete(id); continue; }
      const run = state.runs.find(r => r.id === m.runId);
      if (['cancelled', 'complete', 'failed'].includes(run.status)) { m.status = run.status; pending.delete(id); continue; }
      if (run.status === 'cancel_requested') { m.status = run.status = 'cancelled'; run.canCancel = false; pending.delete(id); continue; }
      if (run.status === 'unknown') { m.status = 'unknown'; run.canCancel = false; pending.delete(id); continue; }
      if (run.status === 'queued') {
        if (state.runs.some(r => r.agentId === run.agentId && ['running', 'cancel_requested'].includes(r.status))) continue;
        run.status = 'running'; run.queuePosition = 0; run.canCancel = true;
      }
      job.step++;
      m.text = job.step === 1 ? job.text.slice(0, Math.ceil(job.text.length / 2)) : job.text;
      if (job.step >= 2) { m.status = run.status = 'complete'; run.canCancel = false; pending.delete(id); }
    }
    const positions = new Map();
    for (const run of state.runs) if (run.status === 'queued') { const position = (positions.get(run.agentId) || 0) + 1; positions.set(run.agentId, position); run.queuePosition = position; }
    publish();
    if (!pending.size) { clearInterval(timer); timer = undefined; }
  }
  function schedule() { if (!manual && !paused && !timer && pending.size) timer = setInterval(advance, 650); }
  const transport = {
    async query(input) {
      if (!online) throw clientError('unavailable', '模拟连接已断开。');
      if (['artifact', 'artifactVersions'].includes(input.type)) return artifacts.query(input);
      if (input.type === 'questionOperation') return questions.query(input);
      if (input.type === 'toolDetails') { if (!toolDetails.has(input.ref)) throw clientError('expired', '模拟工具输出已过期。'); return structuredClone(toolDetails.get(input.ref)); }
      return ['connections', 'testConnection', 'modelCatalog'].includes(input.type) ? settings.query(input) : admin.query(input);
    },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    async snapshot() { if (!online) throw clientError('unavailable', '模拟连接已断开。'); const value = snapshot(); return holdSnapshots ? new Promise(resolve => delayedSnapshots.push(() => resolve(value))) : value; },
    async command(input) {
      if (!online) throw clientError('unavailable', '模拟连接已断开。');
      const c = commandSchema.parse(input);
      if (['answerQuestion', 'requestQuestionAdvice', 'adoptQuestionAdvice'].includes(c.type)) return questions.execute(c);
      if (['saveConnection', 'removeConnection'].includes(c.type)) return settings.execute(c);
      if (c.type === 'launchAgent' && c.connectionId) {
        const result = settings.query({ type: 'modelCatalog', connectionId: c.connectionId, model: c.model });
        const profile = settings.query({ type: 'connections' }).profiles.find(p => p.id === c.connectionId);
        const compatibility = result.catalog.find(m => m.id === (c.model ?? profile.model).trim())?.compatibility.find(item => item.engineId === c.engineId);
        if (!profile.compatibleEngines.includes(c.engineId) || compatibility?.status === 'incompatible') throw clientError('invalid_connection', compatibility?.reason || '此引擎不支持该连接的协议。');
      }
      if (!['send', 'decide', 'cancelRun'].includes(c.type)) return admin.execute(c);
      if (c.type === 'cancelRun') {
        const run = state.runs.find(r => r.id === c.runId);
        if (!run?.canCancel) throw clientError('not_running', '执行已结束或不能取消。');
        run.status = 'cancel_requested'; run.canCancel = false; publish();
        return { accepted: true, operationId: `cancel-${run.id}` };
      }
      if (c.type === 'send') {
        const digest = JSON.stringify(c), previous = receipts.get(c.key);
        if (previous) { if (previous.digest !== digest) throw clientError('conflict', '相同命令标识不能提交不同内容。'); return previous.receipt; }
        const room = state.rooms.find(r => r.id === c.roomId);
        if (!room) throw clientError('not_found', '会话不存在。');
        for (const mention of c.mentions) {
          const agent = state.agents.find(a => a.id === mention.agentId);
          if (!agent || !room.memberIds.includes(agent.id) || c.text.slice(mention.start, mention.end) !== `@${agent.name}`) throw clientError('invalid_mentions', '提及已变化，请重新选择成员。');
        }
        if (!c.text.trim()) throw clientError('invalid_text', '请先输入消息。');
        if (c.mode === 'task' && (!c.ownerAgentId || !room.memberIds.includes(c.ownerAgentId))) throw clientError('invalid_owner', '请选择一位房间成员负责。');
        const m = message(room.id, 'user', c.text);
        // Discussion is recorded; explicit mentions request simulated responses. A task has one owner.
        const targets = c.mode === 'task' ? [c.ownerAgentId] : room.type === 'dm' ? room.memberIds : [...new Set(c.mentions.map(x => x.agentId))];
        for (const target of targets) {
          const reply = message(room.id, target, '', 'running');
          reply.runId = `run-${reply.id}`;
          const queued = state.runs.filter(r => r.agentId === target && ['running', 'queued', 'cancel_requested'].includes(r.status)).length;
          state.runs.push({ id: reply.runId, agentId: target, roomId: room.id, messageId: reply.id, status: queued ? 'queued' : 'running', queuePosition: queued, canCancel: !queued, error: '' });
          const text = c.mode === 'task'
            ? `我来负责这项工作。\n\n会先整理目标与验收条件，再按需要委派。\n\n> 这是模拟回复，没有启动引擎或执行本机操作。`
            : `收到，我会从自己的视角参与讨论。\n\n你刚才提到：\n\n> ${c.text.replace(/\n/g, '\n> ')}\n\n这是模拟回复，用于检查阅读与交互。`;
          pending.set(reply.id, { step: 0, text });
        }
        const receipt = { accepted: true, operationId: `operation-${m.id}`, messageId: m.id };
        receipts.set(c.key, { digest, receipt }); publish(); schedule(); return receipt;
      }
      const request = state.approvals.find(r => r.id === c.approvalId);
      if (!request) throw clientError('expired', '确认请求已失效。');
      if (request.revision !== c.expectedRevision) throw clientError('conflict', '请求已变化，请重新检查。');
      if (c.allow && request.kind === 'questions' && request.questions.some((q, index) => !c.answers[index]?.some(answer => answer.trim()))) throw clientError('required', '请回答每个问题。');
      if (c.allow && request.kind === 'input' && (!c.value.trim() || request.options.length && !request.options.includes(c.value))) throw clientError('invalid_answers', '请输入有效回答。');
      state.approvals = state.approvals.filter(r => r.id !== request.id);
      if (decisionUnknown) { decisionUnknown = false; state.approvalHistory.push({ ...request, decision: c.allow ? 'allow' : 'deny', status: 'unknown', delivery: 'unknown' }); publish(); throw clientError('decision_unknown', '模拟答复投递结果未知。', 'unknown'); }
      state.approvalHistory.push({ ...request, decision: c.allow ? 'allow' : 'deny', status: c.allow ? 'allowed' : 'denied', delivery: 'confirmed' });
      message(request.roomId, request.agentId, c.allow ? '已收到本次确认。模拟场景处理完成。' : '已取消这次模拟操作。');
      publish(); return { accepted: true, operationId: `decision-${request.id}`, delivery: 'confirmed' };
    },
  };
  const control = {
    artifact: roomId => artifacts.add(roomId),
    question: questions.create, questionFailure: questions.fail, questionChange: questions.change,
    adviceResults: questions.results, adviceMemberLeft: questions.memberLeft,
    advance,
    failNext(type) { settings.failNext(type); admin.failNext(type); },
    telemetry: admin.telemetry,
    launchUnknown: admin.launchUnknown,
    decisionUnknown() { decisionUnknown = true; },
    holdSnapshots() { holdSnapshots = true; },
    releaseSnapshots() { holdSnapshots = false; delayedSnapshots.splice(0).forEach(resolve => resolve()); },
    duplicate() { if (online) emit({ type: 'snapshot', data: snapshot() }); },
    gap() { if (online) emit({ type: 'delta', baseRevision: state.revision + 10, offset: 999 }); },
    pause() { paused = true; clearInterval(timer); timer = undefined; },
    resume() { paused = false; schedule(); },
    cancelUnknown() { for (const run of state.runs) if (run.status === 'cancel_requested') { run.status = 'unknown'; run.error = '模拟取消确认丢失'; } publish(); },
    disconnect() { online = false; emit({ type: 'offline' }); },
    reconnect() { online = true; emit({ type: 'resync' }); },
    /** @param {boolean | 'empty-workspace'} empty */
    reset(empty = false) {
      clearInterval(timer); timer = undefined; pending.clear(); receipts.clear(); sequence = 2; requestNumber = 0; elapsed = 0; paused = false;
      state = initial(`mock-${++incarnation}`); if (empty) state.messages = [];
      settings.reset();
      toolDetails.clear();
      admin.reset(); decisionUnknown = false;
      questions.reset();
      if (empty === 'empty-workspace') { state.rooms = []; state.agents = []; }
      online = true; publish();
    },
    approval(kind = 'permission', roomId = 'room-design') {
      const room = state.rooms.find(r => r.id === roomId) || state.rooms[0];
      const agentId = room.ownerAgentId || room.memberIds[0];
      state.approvals.push({ id: `approval-${incarnation}-${++requestNumber}`, agentId, roomId: room.id, revision: 0, kind,
        title: kind === 'questions' ? '这次改版优先保留什么？' : '运行项目检查', summary: kind === 'questions' ? '选择后可补充说明。' : 'npm run check\n仅模拟确认流程，不运行命令。',
        scopeLabel: '仅本次操作', directory: '模拟工作区', options: [],
        questions: kind === 'questions' ? [{ id: 'layout', title: '希望保留哪些设计？', multiple: true, options: ['保持现有布局', '保留头像与配色'] }] : [],
      }); publish();
    },
    expire() { state.approvalHistory.push(...state.approvals.map(r => ({ ...r, status: 'expired' }))); state.approvals = []; publish(); },
    tools(roomId = 'room-design') {
      const room = state.rooms.find(r => r.id === roomId) || state.rooms[0];
      const m = message(room.id, room.memberIds[0], '检查完成，差异已整理。可以展开查看过程。');
      m.tools = [
        { id: `read-${m.id}`, name: '读取文件', status: 'completed', detail: 'welcome.ts', output: '已读取 1 个文件', patches: [] },
        { id: `patch-${m.id}`, name: '修改预览', status: 'completed', detail: '调整欢迎语', output: '1 行新增，1 行删除（模拟数据）', patches: [samplePatch] },
      ];
      for (const tool of m.tools) {
        tool.detailRef = `mock-detail-${tool.id}`; tool.hasDiff = Boolean(tool.patches.length);
        toolDetails.set(tool.detailRef, { id: tool.detailRef, runId: null, output: tool.output, patches: tool.patches, truncated: false });
        tool.patches = []; tool.output = tool.output.slice(0, 300);
      }
      publish();
    },
    longTools(roomId) { control.tools(roomId); const tool = state.messages.at(-1).tools[1]; const detail = toolDetails.get(tool.detailRef); detail.output = '模拟长输出\n'.repeat(2000).slice(0, 16000); detail.truncated = true; tool.truncated = true; publish(); },
    invalidDiff(roomId) { control.tools(roomId); toolDetails.get(state.messages.at(-1).tools[1].detailRef).patches = ['这不是有效 patch']; },
    largeDiff(roomId) { control.tools(roomId); toolDetails.get(state.messages.at(-1).tools[1].detailRef).patches = ['--- a/large.txt\n+++ b/large.txt\n@@ -1,400 +1,400 @@\n' + Array.from({ length: 400 }, (_, i) => `-旧行 ${i}\n+新行 ${i}\n`).join('')]; },
    failedTools(roomId) { control.tools(roomId); state.messages.at(-1).tools[1].status = 'failed'; toolDetails.get(state.messages.at(-1).tools[1].detailRef).output = '模拟工具执行失败，请检查输入。'; publish(); },
    expireTools() { toolDetails.clear(); },
    history(roomId = 'room-design') { for (let i = 0; i < 35; i++) message(roomId, i % 2 ? 'beta' : 'alpha', `讨论记录 ${i + 1}\n\n保留清楚的文字层级与稳定的消息位置。\n\n| 项目 | 状态 |\n| --- | --- |\n| 布局 | 已讨论 |\n| 交互 | 待验证 |`); publish(); },
    dispose() { clearInterval(timer); listeners.clear(); pending.clear(); delayedSnapshots.splice(0).forEach(resolve => resolve()); },
  };
  return { transport, control };
}
