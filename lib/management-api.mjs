import { randomUUID } from 'node:crypto';
import { clientError } from '../contracts/chat.mjs';
export function createManagementApi(service) {
  const receipt = entityId => ({ accepted: true, operationId: randomUUID(), ...(entityId ? { entityId } : {}) });
  return {
    async query(input) { if (input.refresh) await service.rescan(); const state = service.snapshot(); return { engines: state.engines || [], version: state.version || '', configurationError: state.configurationError || '', simulated: false }; },
    async execute(command) {
      const state = service.snapshot();
      if (command.type === 'createWorkspace') return receipt((await service.createWorkspace(command)).workspace.id);
      if (command.type === 'createRoom') return receipt((await service.createRoom({ ...command, members: command.memberIds })).room.id);
      if (command.type === 'setRoomMembers') { await service.setRoomMembers(command.roomId, command.memberIds); return receipt(command.roomId); }
      if (command.type === 'launchAgent') {
        const workspace = state.workspaces.find(w => w.id === command.workspaceId);
        if (!workspace) throw clientError('not_found', '请先选择有效工作区。');
        if (!state.engines.some(e => e.id === command.engineId && e.installed)) throw clientError('unavailable', '该引擎尚未安装。');
        try {
          const result = await service.launch({ tool: command.engineId, directory: workspace.directory, tag: command.tag, connectionId: command.connectionId, model: command.model, capabilities: command.capabilities });
          return receipt(result.result.names?.[0] || result.result.handles?.[0]?.instance_name);
        } catch (error) { throw clientError(error.outcomeKnown ? 'launch_failed' : 'launch_unknown', error.message, error.outcomeKnown ? 'rejected' : 'unknown'); }
      }
      if (!state.agents.some(a => a.id === command.agentId)) throw clientError('not_found', 'Agent 已不存在。');
      if (command.type === 'removeAgent') await service.removeAgent(command.agentId);
      else { await service.stopSession(command.agentId); await service.refresh(); }
      return receipt(command.agentId);
    },
  };
}
