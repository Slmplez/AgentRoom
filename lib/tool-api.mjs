import { clientError } from '../contracts/chat.mjs';
export const toolReference = (agent, tool) => `tool:${agent.id}:${agent.sessionId || 'current'}:${tool.id}`;
export function toolSummary(agent, tool) {
  return { id: toolReference(agent, tool), runId: `run:${agent.id}:${tool.turnId}`, name: tool.kind, status: tool.status, detail: String(tool.detail || '').slice(0, 500), output: String(tool.output || '').slice(0, 300), patches: [], detailRef: toolReference(agent, tool), hasDiff: Boolean(tool.diffs?.length), truncated: Boolean(tool.outputTruncated || String(tool.output || '').length > 300 || tool.diffs?.some(d => d.unavailable)) };
}
export function createToolApi(service) {
  return {
    query(input) {
      for (const agent of service.snapshot().agents) {
        const tool = (agent.rpc?.tools || []).find(t => toolReference(agent, t) === input.ref);
        if (!tool) continue;
        const patches = (tool.diffs || []).filter(d => d.patch).map(d => d.patch);
        const bounded = []; let bytes = 0;
        for (const patch of patches) { bytes += Buffer.byteLength(patch); if (bytes <= 256000) bounded.push(patch); }
        return { id: input.ref, runId: `run:${agent.id}:${tool.turnId}`, output: String(tool.output || '').slice(0, 16000), patches: bounded, truncated: Boolean(tool.outputTruncated || String(tool.output || '').length > 16000 || bytes > 256000 || tool.diffs?.some(d => d.unavailable)) };
      }
      throw clientError('expired', '工具输出已过期，请查看该执行的保留记录。');
    },
  };
}
