// Session-local metrics only. Never persist prompts, replies, credentials or tools.
import { mkdir, writeFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export default function contextTelemetry(pi) {
  const directory = process.env.AGENT_ROOM_CONTEXT_DIR;
  if (!directory) return;
  let pending = Promise.resolve(), sequence = 0, waitingForModelUsage = false, failedWithoutUsage = false, completedModel = null;
  const validCount = value => Number.isSafeInteger(value) && value >= 0;
  const report = (event, ctx) => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      if (!/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)) return;
      const usage = ctx.getContextUsage?.();
      if (event.type === 'session_start') {
        const assistants = (ctx.sessionManager.getBranch?.() || []).filter(entry => entry.type === 'message' && entry.message?.role === 'assistant').map(entry => entry.message);
        const lastGood = assistants.findLast(message => !['error', 'aborted'].includes(message.stopReason) &&
          ((message.usage?.totalTokens || 0) > 0 || ['input', 'output', 'cacheRead', 'cacheWrite'].some(key => (message.usage?.[key] || 0) > 0)));
        waitingForModelUsage = Boolean(lastGood && (lastGood.model !== ctx.model?.id || (lastGood.provider && lastGood.provider !== ctx.model?.provider)));
        failedWithoutUsage = !lastGood && assistants.length > 0 && usage?.tokens === 0;
        completedModel = null;
      }
      if (event.type === 'model_select') { waitingForModelUsage = true; completedModel = null; }
      if (event.type === 'message_end') {
        if (event.message?.role === 'assistant') {
          failedWithoutUsage = ['error', 'aborted'].includes(event.message.stopReason) && usage?.tokens === 0;
          completedModel = ['error', 'aborted'].includes(event.message.stopReason) ? null : event.message.model;
        }
        // Pi emits message_end before persisting it. getContextUsage still
        // describes the previous message until turn_end/agent_end.
        return;
      }
      if (['turn_end', 'agent_end'].includes(event.type) && completedModel === ctx.model?.id) waitingForModelUsage = false;
      const known = !waitingForModelUsage && validCount(usage?.tokens) && !(failedWithoutUsage && usage.tokens === 0);
      const window = usage?.contextWindow ?? ctx.model?.contextWindow;
      const observation = { version: 1, sessionId, directory: ctx.cwd,
        used: known ? usage.tokens : null,
        window: validCount(window) && window > 0 ? window : null,
        model: ctx.model?.id || null, provider: ctx.model?.provider || null,
        updatedAt: new Date().toISOString(), source: 'pi-runtime',
        reason: known ? null : waitingForModelUsage ? '模型已切换，等待新的 Token 记录' : 'Pi 暂未提供当前占用，等待下一次上下文更新' };
      const target = path.join(directory, `${sessionId}.json`);
      const temporary = `${target}.${process.pid}.${++sequence}.tmp`;
      pending = pending.then(async () => {
        try {
          await mkdir(directory, { recursive: true });
          await writeFile(temporary, JSON.stringify(observation), { mode: 0o600 });
          await rename(temporary, target);
        } finally { await unlink(temporary).catch(() => {}); }
      }).catch(() => {});
      return pending;
    } catch { /* Telemetry must not interrupt the agent. */ }
  };
  for (const event of ['session_start', 'model_select', 'message_end', 'turn_end', 'agent_end', 'session_compact', 'session_tree', 'session_shutdown']) pi.on(event, report);
}
