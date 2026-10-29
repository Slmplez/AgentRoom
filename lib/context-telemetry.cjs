const fs = require('node:fs/promises');
const path = require('node:path');

const count = value => Number.isSafeInteger(value) && value >= 0;
const limit = value => count(value) && value > 0 ? value : null;
const inferenceRoutes = new Set(['responses', 'chat/completions', 'messages']);
const unknown = () => ({ used: null, window: null, source: 'unknown', windowSource: 'unknown', updatedAt: null, model: null });

// These are observations of the latest request, never the sum of session usage.
class ContextTelemetry {
  constructor({ dataDir } = {}) { this.bindings = new Map(); this.files = new Map(); this.dataDir = dataDir; }
  async piExtension() {
    const directory = path.join(this.dataDir, 'context');
    const extension = path.join(this.dataDir, 'runtime', 'agent-room-context.mjs');
    await fs.mkdir(path.dirname(extension), { recursive: true });
    await fs.mkdir(directory, { recursive: true });
    await fs.copyFile(path.join(__dirname, 'pi-context-extension.mjs'), extension);
    return { args: ['--extension', extension], env: { AGENT_ROOM_CONTEXT_DIR: directory } };
  }
  createScope(profile, model) {
    return { model: model || profile.model, window: limit(profile.contextWindow), latest: null, sequence: -1 };
  }
  record(scope, metadata, usage) {
    if (!inferenceRoutes.has(metadata.route)) return;
    const sequence = metadata.requestSequence;
    if (!count(sequence) || sequence < scope.sequence) return;
    scope.sequence = sequence;
    const valid = metadata.status >= 200 && metadata.status < 300 && metadata.completed === true && metadata.usageComplete === true && !metadata.interrupted && usage && count(usage.input) && count(usage.output) && count(usage.input + usage.output);
    scope.latest = { used: valid ? usage.input + usage.output : null,
      model: metadata.model || scope.model, source: 'gateway', updatedAt: new Date().toISOString(),
      reason: valid ? null : '最近请求未提供完整用量或已中断' };
  }
  bind(scope, names, agents) {
    for (const name of names) {
      if (typeof name !== 'string') continue;
      const agent = agents.find(agent => agent.id === name || agent.name === name);
      this.bindings.set(agent?.id || name, { scope, sessionId: agent?.sessionId || '', directory: agent?.directory });
    }
  }
  snapshot(agent) {
    const binding = this.bindings.get(agent.id) || this.bindings.get(agent.name);
    if (!binding || (binding.directory && binding.directory !== agent.directory)) return unknown();
    if (!binding.directory) binding.directory = agent.directory;
    if (binding.sessionId && binding.sessionId !== agent.sessionId) return unknown();
    if (agent.sessionId) binding.sessionId = agent.sessionId;
    const scope = binding.scope;
    return { ...unknown(), window: scope.window, windowSource: scope.window ? 'configured' : 'unknown', model: scope.model, ...scope.latest };
  }
  async observe(agent, transcriptPath) {
    let gateway = this.snapshot(agent);
    if (agent.tool === 'pi' && this.dataDir && /^[a-zA-Z0-9_-]{1,128}$/.test(agent.sessionId || '')) {
      try {
        const filename = path.join(this.dataDir, 'context', `${agent.sessionId}.json`);
        const stat = await fs.stat(filename);
        if (stat.isFile() && stat.size <= 16384) {
          const value = JSON.parse(await fs.readFile(filename, 'utf8'));
          if (value.version === 1 && value.sessionId === agent.sessionId && sameDirectory(value.directory, agent.directory) && Number.isFinite(Date.parse(value.updatedAt))) {
            const observation = { ...unknown(), used: count(value.used) ? value.used : null, window: limit(value.window),
              windowSource: limit(value.window) ? 'reported' : 'unknown', model: typeof value.model === 'string' ? value.model : null,
              source: 'pi-runtime', updatedAt: value.updatedAt, reason: typeof value.reason === 'string' ? value.reason : null };
            gateway = mergeObservation(gateway, observation);
          }
        }
      } catch { /* Existing sessions can still use their transcript. */ }
    }
    if (!['codex', 'pi'].includes(agent.tool) || !agent.sessionId || !transcriptPath || !path.isAbsolute(transcriptPath)) return gateway;
    try {
      const file = await fs.open(transcriptPath, 'r');
      let native;
      try {
        const stat = await file.stat();
        if (!stat.isFile()) return gateway;
        const key = `${agent.tool}:${agent.sessionId}:${agent.directory}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
        const cached = this.files.get(transcriptPath);
        if (cached?.key === key) native = cached.value;
        else {
          // Bound I/O and never expose transcript content to the renderer or usage ledger.
          const head = Buffer.alloc(Math.min(stat.size, 16384));
          const headerRead = await file.read(head, 0, head.length, 0);
          const first = head.subarray(0, headerRead.bytesRead).toString('utf8').split('\n')[0];
          const header = JSON.parse(first);
          if (agent.tool === 'codex' ? header.type !== 'session_meta' || header.payload?.id !== agent.sessionId || (header.payload?.cwd && !sameDirectory(header.payload.cwd, agent.directory))
            : header.type !== 'session' || header.id !== agent.sessionId || !sameDirectory(header.cwd, agent.directory)) return gateway;
          const start = Math.max(0, stat.size - 512 * 1024);
          const tail = Buffer.alloc(stat.size - start);
          const tailRead = await file.read(tail, 0, tail.length, start);
          native = (agent.tool === 'pi' ? parsePiContext : parseCodexContext)(tail.subarray(0, tailRead.bytesRead).toString('utf8'), start > 0);
          if (this.files.size >= 128) this.files.delete(this.files.keys().next().value);
          this.files.set(transcriptPath, { key, value: native });
        }
      } finally { await file.close(); }
      return mergeObservation(gateway, native);
    } catch { return gateway; }
  }
}

function sameDirectory(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const normalize = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(a) === normalize(b);
}
function mergeObservation(previous, observed) {
  if (!observed || (previous.updatedAt && Date.parse(previous.updatedAt) > Date.parse(observed.updatedAt))) return previous;
  const fallbackWindow = observed.model && observed.model === previous.model ? previous.window : null;
  return { ...previous, ...observed, window: observed.window || fallbackWindow,
    windowSource: observed.window ? 'reported' : fallbackWindow ? previous.windowSource : 'unknown' };
}

function parsePiContext(text, partialStart = false) {
  const lines = text.split('\n');
  if (partialStart) lines.shift();
  lines.pop();
  let entries = lines.flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  // Pi stores a session tree. Only the latest leaf's ancestry belongs to the
  // active conversation; an abandoned branch must not supply a usage reading.
  const leaf = entries.at(-1);
  if (leaf?.id && Object.hasOwn(leaf, 'parentId')) {
    const byId = new Map(entries.filter(e => e.id).map(e => [e.id, e]));
    const branch = [], visited = new Set();
    for (let e = leaf; e && !visited.has(e.id); e = byId.get(e.parentId)) { visited.add(e.id); branch.push(e); }
    entries = branch.reverse();
  }
  let result = null, model = null, provider = null;
  for (const entry of entries) {
    if (!Number.isFinite(Date.parse(entry.timestamp))) continue;
    if (entry.type === 'model_change' && typeof entry.modelId === 'string') {
      if (model !== entry.modelId || provider !== entry.provider) result = { ...unknown(), model: entry.modelId, source: 'pi-transcript', updatedAt: entry.timestamp, reason: '模型已切换，等待新的 Token 记录' };
      model = entry.modelId;
      provider = entry.provider;
    }
    if (['compaction', 'branch_summary', 'context_edit'].includes(entry.type)) result = { ...unknown(), model, source: 'pi-transcript', updatedAt: entry.timestamp, reason: '上下文已重新整理，等待下一次 Token 记录' };
    const message = entry.message;
    if (entry.type !== 'message' || message?.role !== 'assistant') continue;
    if (typeof message.model === 'string') {
      if (model !== message.model || (message.provider && provider && provider !== message.provider)) result = null;
      model = message.model;
      provider = message.provider || provider;
    }
    const usage = message.usage;
    const total = count(usage?.totalTokens) && usage.totalTokens > 0 ? usage.totalTokens
      : usage && ['input', 'output', 'cacheRead', 'cacheWrite'].every(key => count(usage[key] ?? 0))
        ? ['input', 'output', 'cacheRead', 'cacheWrite'].reduce((sum, key) => sum + (usage[key] || 0), 0) : null;
    if (['error', 'aborted'].includes(message.stopReason) || !count(total) || total === 0) {
      if (!result || result.used === null) result = { ...unknown(), model, source: 'pi-transcript', updatedAt: entry.timestamp, reason: '尚无成功请求的 Token 记录' };
      continue;
    }
    result = { ...unknown(), used: total, model, source: 'pi-transcript', updatedAt: entry.timestamp,
      reason: '最近完成请求的上下文估算；后续新增消息尚未计入' };
  }
  return result;
}

function parseCodexContext(text, partialStart = false) {
  const lines = text.split('\n');
  if (partialStart) lines.shift();
  // A writer can leave the final JSON record incomplete. Wait for the newline.
  lines.pop();
  let result = null, model = null, window = null;
  for (const line of lines) {
    let event; try { event = JSON.parse(line); } catch { continue; }
    const p = event.payload;
    if (event.type === 'turn_context' && typeof p?.model === 'string') {
      if ((model || result) && model !== p.model) {
        window = null;
        result = Number.isFinite(Date.parse(event.timestamp)) ? { ...unknown(), model: p.model, source: 'codex-transcript',
          updatedAt: event.timestamp, reason: '模型已切换，等待新的 Token 记录' } : null;
      }
      model = p.model;
    }
    if (event.type === 'event_msg' && p?.type === 'task_started') window = limit(p.model_context_window) || window;
    const compacted = event.type === 'compacted' || (event.type === 'event_msg' && p?.type === 'context_compacted');
    if (!compacted && !(event.type === 'event_msg' && p?.type === 'token_count' && p.info)) continue;
    if (!Number.isFinite(Date.parse(event.timestamp))) continue;
    window = limit(p?.info?.model_context_window) || window;
    const usage = p?.info?.last_token_usage;
    const used = !compacted && usage && count(usage.input_tokens) && count(usage.output_tokens) && count(usage.input_tokens + usage.output_tokens) ? usage.input_tokens + usage.output_tokens : null;
    result = { used, window, windowSource: window ? 'reported' : 'unknown', model, source: 'codex-transcript',
      updatedAt: event.timestamp, reason: compacted ? '上下文已压缩，等待下一次 Token 记录' : used === null ? '会话未提供最近一次用量' : null };
  }
  return result;
}
module.exports = { ContextTelemetry, parseCodexContext, parsePiContext };
