import { clientError } from '../../contracts/chat.mjs';

export function createMockAdmin(read, publish) {
  let unknownLaunch = false;
  let serial = 0, library = { servers: [], skills: [], bindings: [], agents: [], secureStorageAvailable: true, error: '', simulated: true }, fail = '', known = false;
  const engines = ['codex', 'claude', 'pi', 'opencode'].map(id => ({ id, label: id, installed: true }));
  const emptyTotals = () => ({ requests: 0, known: 0, unknown: 0, errors: 0, input: 0, output: 0, cached: 0, cacheWrite: 0, total: 0 });
  function check(type) { if (type === fail) { fail = ''; throw clientError('simulated_failure', '模拟操作失败，已有内容保留。'); } }
  const receipt = entityId => ({ accepted: true, operationId: `mock-operation-${++serial}`, ...(entityId ? { entityId } : {}) });
  return {
    query(input) {
      check(input.type);
      if (input.type === 'catalog') return { engines, version: '模拟', configurationError: '', simulated: true };
      if (input.type === 'capabilities') return structuredClone(library);
      if (input.type === 'testCapabilityServer') {
        if (!library.servers.some(s => s.id === input.id)) throw clientError('not_found', '模拟服务不存在。');
        return { ok: true, message: '模拟连接成功，未启动 MCP 进程。', tools: [{ name: 'example_read', description: '模拟读取工具' }] };
      }
      if (input.type === 'contexts') return { simulated: true, agents: read().agents.map(a => ({ agentId: a.id, context: { used: known ? 4096 : null, window: 128000, source: known ? 'pi-runtime' : 'unknown', windowSource: 'configured', confidence: known ? 'estimated' : 'unknown', reason: '模拟观测，非累计用量', updatedAt: '2026-10-30T08:00:00Z' } })) };
      if (input.type === 'usage') {
        const days = Array.from({ length: 364 }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 30 - 363 + i)).toISOString().slice(0, 10), total: 0, requests: 0, unknown: 0 }));
        const totals = known ? { ...emptyTotals(), requests: 2, known: 1, unknown: 1, input: 1000, output: 200, cached: 500, total: 1200 } : emptyTotals();
        if (known) Object.assign(days.at(-1), { total: 1200, requests: 2, unknown: 1 });
        return { simulated: true, totals, days, models: known ? [{ ...totals, label: '模拟模型' }] : [], engines: known ? [{ ...totals, label: 'pi' }] : [], period: { from: days[0].date, to: days.at(-1).date }, timezone: 'UTC', error: '' };
      }
      throw clientError('unsupported', '不支持的模拟查询。');
    },
    execute(c) {
      check(c.type);
      const state = read();
      if (c.type === 'createWorkspace') {
        const id = `mock-workspace-${++serial}`; state.workspaces.push({ id, title: c.title, directory: `模拟目录 · ${c.directory}` }); publish(); return receipt(id);
      }
      if (c.type === 'createRoom' || c.type === 'setRoomMembers') {
        const room = c.type === 'setRoomMembers' ? state.rooms.find(r => r.id === c.roomId) : null;
        if (c.type === 'setRoomMembers' && !room) throw clientError('not_found', '房间不存在。');
        if (room?.type === 'dm') throw clientError('invalid_room', '私聊成员不能修改。');
        const workspaceId = room?.workspaceId || c.workspaceId;
        if (!state.workspaces.some(w => w.id === workspaceId)) throw clientError('not_found', '工作区不存在。');
        if (c.memberIds.some(id => !state.agents.some(a => a.id === id && a.workspaceId === workspaceId))) throw clientError('invalid_members', '成员必须属于同一工作区。');
        if (room) room.memberIds = c.memberIds;
        else state.rooms.push({ id: `mock-room-${++serial}`, title: c.title, type: 'group', memberIds: c.memberIds, workspaceId, ownerAgentId: null });
        publish(); return receipt(room?.id || state.rooms.at(-1).id);
      }
      if (c.type === 'launchAgent') {
        const workspace = state.workspaces.find(w => w.id === c.workspaceId);
        if (!workspace || !engines.some(e => e.id === c.engineId)) throw clientError('invalid_agent', '请选择模拟工作区和引擎。');
        const id = `mock-agent-${++serial}`; state.agents.push({ id, name: id, displayName: id, engine: c.engineId, engineId: c.engineId, tag: c.tag, directory: workspace.directory, workspaceId: workspace.id, status: 'listening' });
        state.rooms.push({ id: `mock-private-${serial}`, title: id, type: 'dm', workspaceId: workspace.id, memberIds: [id], ownerAgentId: id }); publish();
        if (unknownLaunch) { unknownLaunch = false; throw clientError('launch_unknown', '模拟启动已发生，但启动回执丢失；请核查成员列表。', 'unknown'); }
        return receipt(id);
      }
      if (['stopAgent', 'removeAgent'].includes(c.type)) {
        const agent = state.agents.find(a => a.id === c.agentId); if (!agent) throw clientError('not_found', 'Agent 不存在。');
        agent.status = 'inactive';
        if (c.type === 'removeAgent') { state.agents = state.agents.filter(a => a !== agent); for (const room of state.rooms) room.memberIds = room.memberIds.filter(id => id !== agent.id); }
        for (const run of state.runs.filter(r => r.agentId === agent.id && ['running', 'queued', 'cancel_requested'].includes(r.status))) { run.status = 'cancelled'; run.canCancel = false; }
        publish(); return receipt(agent.id);
      }
      if (c.type === 'saveCapabilityServer') {
        const { env, headers, ...data } = c.server, old = library.servers.find(s => s.id === data.id);
        if (data.transport === 'stdio' && !data.command?.trim()) throw clientError('invalid_capability', '请填写模拟命令。');
        const id = data.id || `mock-server-${++serial}`;
        library.servers = [...library.servers.filter(s => s.id !== id), { ...data, id, revision: (old?.revision || 0) + 1, envKeys: env ? Object.keys(env) : old?.envKeys || [], headerKeys: headers ? Object.keys(headers) : old?.headerKeys || [] }]; return receipt(id);
      }
      if (c.type === 'importSkill') {
        const id = c.id || `mock-skill-${++serial}`, old = library.skills.find(s => s.id === id);
        library.skills = [...library.skills.filter(s => s.id !== id), { id, name: '模拟 Skill', description: '未读取本机文件', source: c.directory, revision: (old?.revision || 0) + 1, files: 2, hash: 'simulated-content' }]; return receipt(id);
      }
      if (c.type === 'removeCapability') { library[c.kind] = library[c.kind].filter(item => item.id !== c.id); for (const binding of library.bindings) { binding.serverIds = binding.serverIds.filter(id => id !== c.id); binding.skillIds = binding.skillIds.filter(id => id !== c.id); } return receipt(c.id); }
      if (c.type === 'bindCapabilities') {
        if (!state.workspaces.some(w => w.id === c.workspaceId) || c.serverIds.some(id => !library.servers.some(s => s.id === id)) || c.skillIds.some(id => !library.skills.some(s => s.id === id))) throw clientError('invalid_binding', '请选择已有工作区和能力。');
        library.bindings = [...library.bindings.filter(b => b.workspaceId !== c.workspaceId), { workspaceId: c.workspaceId, serverIds: c.serverIds, skillIds: c.skillIds }]; return receipt();
      }
      throw clientError('unsupported', '不支持的模拟操作。');
    },
    failNext(type) { fail = type; },
    launchUnknown() { unknownLaunch = true; },
    telemetry(value = true) { known = value; },
    reset() { unknownLaunch = false; serial = 0; library = { servers: [], skills: [], bindings: [], agents: [], secureStorageAvailable: true, error: '', simulated: true }; fail = ''; known = false; },
  };
}
