import { clientError } from '../../contracts/chat.mjs';

// Development-only reports use the production DTO. Never used by persistence.
export function createMockArtifacts(read, publish, message) {
  const reports = new Map();
  return {
    add(roomId) {
      const state = read(), room = state.rooms.find(r => r.id === roomId) || state.rooms[0];
      if (!room) return;
      const artifactId = `mock-report:${state.instanceId}:${room.id}`, versions = reports.get(artifactId) || [];
      const version = versions.length + 1, title = `模拟检查报告 ${version}`;
      const report = { artifactId, version, roomId: room.id, taskId: 'mock-task', runId: 'mock-run', producerAgentId: room.memberIds[0], title, catalogVersion: 1, createdAt: '2026-10-31T00:00:00Z', contentHash: '0'.repeat(64), spec: { root: 'r', elements: { r: { type: 'Section', props: { title, description: '模拟数据，用于独立开发；没有调用 Agent。' }, children: [] } } } };
      reports.set(artifactId, [...versions, report]);
      message(room.id, report.producerAgentId, title).artifactRefs = [{ artifactId, version, title, catalogVersion: 1 }];
      state.capabilities.readOnlyArtifacts = true; publish();
    },
    query(q) {
      const versions = reports.get(q.artifactId)?.filter(v => v.roomId === q.roomId);
      if (!versions?.length) throw clientError('not_found', '模拟报告不存在。');
      if (q.type === 'artifact') { const report = versions.find(v => v.version === q.version); if (!report) throw clientError('not_found', '模拟报告版本不存在。'); return structuredClone(report); }
      const rows = versions.filter(v => !q.beforeVersion || v.version < q.beforeVersion).reverse().slice(0, q.limit || 20).map(({ spec, ...meta }) => meta);
      return { versions: rows, beforeVersion: rows.length === (q.limit || 20) ? rows.at(-1).version : null };
    },
  };
}
