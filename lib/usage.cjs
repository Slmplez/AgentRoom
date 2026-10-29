const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const count = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
function extractUsage(value) {
  const usage = value?.response?.usage || value?.message?.usage || value?.usage;
  if (!usage || !['input_tokens', 'prompt_tokens', 'output_tokens', 'completion_tokens'].some(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) return null;
  const cached = count(usage.cache_read_input_tokens ?? usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens);
  const cacheWrite = count(usage.cache_creation_input_tokens);
  // Anthropic reports fresh input separately from cached input; OpenAI includes cached input in input_tokens.
  const anthropic = Object.hasOwn(usage, 'cache_read_input_tokens') || Object.hasOwn(usage, 'cache_creation_input_tokens');
  return { input: count(usage.input_tokens ?? usage.prompt_tokens) + (anthropic ? cached + cacheWrite : 0), output: count(usage.output_tokens ?? usage.completion_tokens), cached, cacheWrite };
}
class UsageCollector {
  constructor(contentType = '') {
    this.sse = /text\/event-stream/i.test(contentType);
    this.pending = ''; this.oversizedLine = false; this.jsonBytes = 0;
    this.decoder = new (require('node:string_decoder').StringDecoder)('utf8');
    this.usage = null;
  }
  accept(value) {
    const model = value?.response?.model || value?.message?.model || value?.model;
    if (typeof model === 'string' && model.length <= 200 && !/[\r\n\0]/.test(model)) this.model = model;
    const usage = extractUsage(value); if (!usage) return;
    if (!this.usage) this.usage = usage;
    else for (const key of Object.keys(usage)) this.usage[key] = Math.max(this.usage[key], usage[key]);
  }
  json(line) { try { this.accept(JSON.parse(line)); } catch { /* Text deltas and [DONE] carry no usage. */ } }
  push(chunk) {
    const text = this.decoder.write(chunk);
    if (!this.sse) {
      this.jsonBytes += chunk.length;
      if (this.jsonBytes <= 2 * 1024 * 1024) this.pending += text; else this.pending = '';
      return;
    }
    for (const fragment of text.split(/(?<=\n)/)) {
      if (!this.oversizedLine) this.pending += fragment;
      if (this.pending.length > 1024 * 1024) { this.oversizedLine = true; this.pending = ''; }
      if (fragment.endsWith('\n')) {
        if (!this.oversizedLine && this.pending.startsWith('data:')) this.json(this.pending.slice(5).trim());
        this.pending = ''; this.oversizedLine = false;
      }
    }
  }
  finish() {
    this.pending += this.decoder.end();
    if (this.sse && !this.oversizedLine && this.pending.startsWith('data:')) this.json(this.pending.slice(5).trim());
    if (!this.sse && this.jsonBytes <= 2 * 1024 * 1024) this.json(this.pending);
    this.pending = '';
    return this.usage;
  }
}
function dayKey(timestamp) {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
function aggregateUsage(events, today = new Date()) {
  const days = [], byDay = new Map(), engines = new Map(), models = new Map();
  const totals = { requests: 0, known: 0, unknown: 0, errors: 0, input: 0, output: 0, cached: 0, cacheWrite: 0, total: 0 };
  for (let offset = 363; offset >= 0; offset--) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - offset);
    const row = { date: dayKey(date), requests: 0, unknown: 0, total: 0 }; days.push(row); byDay.set(row.date, row);
  }
  const since = days[0].date, until = dayKey(today);
  const add = (target, event) => {
    target.requests++; if (event.usage) {
      target.known++;
      for (const key of ['input', 'output', 'cached', 'cacheWrite']) target[key] += count(event.usage[key]);
      target.total += count(event.usage.input) + count(event.usage.output);
    } else target.unknown++;
    if (event.status >= 400 || event.interrupted) target.errors++;
  };
  for (const event of events) {
    const date = dayKey(event.timestamp); if (date < since || date > until) continue;
    add(totals, event);
    const day = byDay.get(date); if (day) { day.requests++; day.total += count(event.usage?.input) + count(event.usage?.output); if (!event.usage) day.unknown++; }
    for (const [map, key] of [[engines, event.engine], [models, event.model]]) {
      if (!map.has(key)) map.set(key, { label: key, ...Object.fromEntries(Object.keys(totals).map(key => [key, 0])) });
      add(map.get(key), event);
    }
  }
  return { totals, days, engines: [...engines.values()].sort((a, b) => b.total - a.total), models: [...models.values()].sort((a, b) => b.total - a.total), period: { from: since, to: until }, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone };
}
class UsageLedger {
  constructor(dataDir) { this.file = path.join(dataDir, 'usage.jsonl'); this.events = []; this.pending = Promise.resolve(); this.error = ''; }
  async load() {
    try {
      const text = await fs.readFile(this.file, 'utf8');
      this.needsSeparator = Boolean(text.length && !text.endsWith('\n'));
      for (const line of text.split(/\r?\n/).filter(Boolean)) {
        try { const event = JSON.parse(line); if (event.version === 1 && event.id && Number.isFinite(Date.parse(event.timestamp))) this.events.push(event); else throw new Error(); }
        catch { this.error = '部分用量记录无法读取，已保留原始文件。'; }
      }
    } catch (error) { if (error.code !== 'ENOENT') this.error = '用量记录无法读取，新的用量暂存于当前进程。'; }
  }
  record(metadata, usage) {
    const event = { version: 1, id: crypto.randomUUID(), timestamp: new Date().toISOString(),
      engine: metadata.engine || 'unknown', model: metadata.model || 'unknown', profileId: metadata.profileId, status: metadata.status || 0, interrupted: Boolean(metadata.interrupted),
      usage: usage ? { input: count(usage.input), output: count(usage.output), cached: count(usage.cached), cacheWrite: count(usage.cacheWrite) } : null };
    this.events.push(event);
    this.pending = this.pending.catch(() => {}).then(async () => {
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.appendFile(this.file, `${this.needsSeparator ? '\n' : ''}${JSON.stringify(event)}\n`, { mode: 0o600 });
        this.needsSeparator = false;
      }
      catch { this.error = '用量写入失败，当前窗口保留本次统计，退出后可能丢失。'; }
    });
    return this.pending;
  }
  snapshot() { return { ...aggregateUsage(this.events), error: this.error }; }
}
module.exports = { UsageCollector, UsageLedger, aggregateUsage, extractUsage };
