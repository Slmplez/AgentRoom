(function (root) {
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const tokens = value => value == null ? '未知' : value < 1000 ? String(value) : `${(value / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  function describe(context = {}) {
    const known = Number.isSafeInteger(context.used) && context.used >= 0;
    const hasLimit = Number.isSafeInteger(context.window) && context.window > 0;
    return !known ? '上下文尚未获取' : `上下文约 ${context.used.toLocaleString()} tokens${hasLimit ? `，占 ${Math.round(context.used / context.window * 100)}%` : '，上限未知'}`;
  }
  function render(context = {}, detail = false, focusable = false) {
    const known = Number.isSafeInteger(context.used) && context.used >= 0;
    const hasLimit = Number.isSafeInteger(context.window) && context.window > 0;
    const used = known ? context.used : null, window = hasLimit ? context.window : null;
    const percent = known && hasLimit ? Math.round(used / window * 100) : null;
    const source = { 'codex-transcript': 'Codex 会话最近一次 Token 记录', 'pi-runtime': 'Pi 当前上下文估算', 'pi-transcript': 'Pi 会话最近一次 Token 记录', gateway: '该启动会话网关最近请求估算，可能包含子任务请求' }[context.source] || '尚未获取此会话的上下文数据';
    const ceiling = hasLimit ? `${context.windowSource === 'reported' ? '引擎报告上限' : '连接方案配置上限'}：${window.toLocaleString()} tokens` : '模型上下文上限未知';
    const time = context.updatedAt && Number.isFinite(Date.parse(context.updatedAt)) ? new Date(context.updatedAt).toLocaleString('zh-CN') : '';
    const stale = time && Date.now() - Date.parse(context.updatedAt) > 5 * 60 * 1000;
    const title = `${describe(context)}。${source}。${ceiling}。${context.reason || ''}${time ? ` 最后更新：${time}${stale ? '（历史观测）' : ''}` : ''}。${context.source === 'pi-runtime' ? '此值来自 Pi 引擎，后续更新可能改变估算' : '此值不包含记录之后新增的消息或工具结果'}，不是累计用量。`;
    const summary = `${known ? '≈' : ''}${tokens(used)}${hasLimit ? ` / ${tokens(window)}` : ''}${percent == null ? '' : ` · ${percent}%`}`;
    const state = !known ? 'unknown' : !hasLimit ? 'unbounded' : percent >= 100 ? 'full' : percent >= 80 ? 'high' : 'known';
    const ring = `<svg class="context-ring context-ring--${state}" viewBox="0 0 20 20" aria-hidden="true"><circle class="context-ring-track" cx="10" cy="10" r="7.5"/>${percent === null ? `<path class="context-ring-mark" d="${known ? 'M10 9.5v1' : 'M7.5 10h5'}"/>` : used > 0 ? `<circle class="context-ring-value" cx="10" cy="10" r="7.5" pathLength="100" stroke-dasharray="${Math.min(100, used / window * 100)} 100" transform="rotate(-90 10 10)"/>` : ''}</svg>`;
    if (!detail) return `<span class="agent-context-compact" role="img" aria-label="${esc(describe(context))}" title="${esc(title)}"${focusable ? ' tabindex="0"' : ''}>${ring}</span>`;
    return `<div class="agent-context" title="${esc(title)}">${ring}<div class="agent-context-copy"><div class="agent-context-label"><span>上下文${stale ? ' · 历史观测' : ''}</span><span>${esc(summary)}</span></div></div></div>`;
  }
  const api = { render, tokens, describe };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.AgentContext = api;
})(typeof window === 'object' ? window : globalThis);
