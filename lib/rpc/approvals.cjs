const { randomUUID } = require('node:crypto');

// One broker per agent incarnation. Wire IDs never serve as UI approval tokens.
class ApprovalBroker {
  constructor() { this.pending = new Map(); this.history = []; this.seen = new WeakSet(); }
  sync(requests, context = {}) {
    for (const entry of this.pending.values()) {
      if (entry.status !== 'submitting' && requests.get(entry.wireId) !== entry.request) this.finish(entry, 'expired');
    }
    for (const [wireId, request] of requests) {
      if (this.seen.has(request)) continue;
      this.seen.add(request);
      const d = request.data || {};
      const entry = { id: randomUUID(), wireId, request, kind: request.kind, status: 'pending',
        createdAt: new Date().toISOString(), ...context,
        title: d.title || d.tool_name || d.permission || d.method || '操作确认',
        scope: 'once', grantScope: d.method === 'item/permissions/requestApproval' ? 'turn' : 'request', data: d };
      this.pending.set(entry.id, entry);
    }
  }
  view(entry) { const { wireId, request, ...view } = entry; return view; }
  list() { return [...this.pending.values()].map(e => this.view(e)); }
  finish(entry, status) {
    if (!this.pending.has(entry.id)) return;
    this.pending.delete(entry.id);
    this.history.push({ ...this.view(entry), status, resolvedAt: new Date().toISOString() });
    this.history = this.history.slice(-100);
  }
  expire() { for (const entry of this.pending.values()) this.finish(entry, 'expired'); }
  async respond(id, answer, engine) {
    const entry = this.pending.get(id);
    if (!entry || engine.requests.get(entry.wireId) !== entry.request) throw new Error('确认请求已失效');
    if (entry.status !== 'pending') throw new Error('确认请求正在处理，请勿重复提交');
    if (typeof answer.allow !== 'boolean' || (answer.cancelled !== undefined && typeof answer.cancelled !== 'boolean') || (answer.scope && answer.scope !== 'once')) throw new Error('确认响应格式错误：仅支持明确的单次决定');
    if (answer.answers !== undefined && (!Array.isArray(answer.answers) || answer.answers.some(a => !Array.isArray(a) || a.some(v => typeof v !== 'string')))) throw new Error('问题回答格式错误');
    if (answer.value !== undefined && typeof answer.value !== 'string') throw new Error('输入格式错误');
    entry.status = 'submitting';
    try {
      const allow = answer.allow && !answer.cancelled;
      const result = await engine.respond(entry.wireId, { ...answer, allow, cancelled: !allow });
      entry.delivery = result?.delivery === 'confirmed' ? 'confirmed' : 'unknown';
      entry.decision = allow ? 'allow' : 'deny';
      this.finish(entry, entry.delivery === 'confirmed' ? allow ? 'allowed' : 'denied' : 'unknown');
      return { delivery: entry.delivery };
    } catch (error) {
      // A failed write may have reached the engine. Never silently resend approval.
      entry.delivery = 'unknown'; this.finish(entry, 'unknown');
      error.uncertain = true;
      throw error;
    }
  }
}
module.exports = { ApprovalBroker };
