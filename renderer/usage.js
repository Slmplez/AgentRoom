window.createUsageUI = ({ client, showModal, icon, esc }) => {
  const $ = selector => document.querySelector(selector);
  const number = value => Number(value || 0).toLocaleString('zh-CN');
  const compact = value => Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value || 0);
  const labels = { codex: 'Codex', claude: 'Claude Code', pi: 'Pi', opencode: 'OpenCode' };
  let latest, timer;
  async function refresh() {
    const target = $('#usage-dashboard'); if (!target) { timer?.(); return; }
    try { latest = await client.query({ type: 'usage' }); if (target.isConnected) render(latest); }
    catch { if (target.isConnected) target.textContent = '暂时无法读取用量统计，请稍后刷新。'; }
  }
  function render(stats) {
    const target = $('#usage-dashboard'); if (!target) return;
    const t = stats.totals, max = Math.max(1, ...stats.days.map(item => item.total));
    const cells = stats.days.map(day => {
      const level = !day.total ? 0 : Math.min(4, Math.max(1, Math.ceil((Math.log1p(day.total) / Math.log1p(max)) * 4)));
      const title = `${day.date} · ${number(day.total)} tokens · ${day.requests} 次请求${day.unknown ? ` · ${day.unknown} 次用量未知` : ''}`;
      return `<span class="usage-cell level-${level} ${day.unknown ? 'has-unknown' : ''}" title="${esc(title)}" aria-label="${esc(title)}"></span>`;
    }).join('');
    const today = stats.days.at(-1), activeDays = stats.days.filter(day => day.requests).length;
    target.innerHTML = `<div class="usage-period"><span>${esc(stats.period.from)} — ${esc(stats.period.to)} · ${esc(stats.timezone)}</span><button class="text-link" data-action="usage-refresh">${icon('refresh')} 刷新</button></div>
      <div class="usage-cards"><div><small>累计 Token</small><strong>${compact(t.total)}</strong><span>已报告 ${number(t.known)} 次请求的用量</span></div><div><small>输入 / 输出</small><strong>${compact(t.input)} <i>/</i> ${compact(t.output)}</strong><span>输入包含缓存命中与缓存写入</span></div><div><small>缓存命中</small><strong>${compact(t.cached)}</strong><span>缓存写入 ${number(t.cacheWrite)} tokens</span></div><div><small>请求次数</small><strong>${number(t.requests)}</strong><span>${number(t.unknown)} 次用量未知 · ${number(t.errors)} 次异常</span></div></div>
      <div class="usage-section-head"><h3>用量砖块图</h3><span>今日 ${number(today?.total)} tokens · ${activeDays} 个活跃日</span></div><div class="usage-calendar-scroll"><div class="usage-months"><span>过去 52 周</span><span>最近</span></div><div class="usage-calendar" role="img" aria-label="过去 364 天的每日 Token 用量，颜色越深，用量越高。悬停查看日期和用量。">${cells}</div></div><div class="usage-legend"><span>每块代表一天，悬停查看详情</span><span>少 <i class="usage-cell level-0"></i><i class="usage-cell level-1"></i><i class="usage-cell level-2"></i><i class="usage-cell level-3"></i><i class="usage-cell level-4"></i> 多</span></div>
      <div class="usage-section-head"><h3>按模型分布</h3><span>${stats.models.length} 个模型</span></div><div class="usage-model-blocks">${stats.models.filter(model => model.total).slice(0, 12).map((model, index) => `<div class="usage-model-block shade-${index % 4}" style="flex-grow:${Math.max(1, Math.round(model.total / Math.max(1, t.total) * 100))}" title="${esc(model.label)} · ${number(model.total)} tokens"><strong>${esc(model.label)}</strong><span>${compact(model.total)} tokens · ${(model.total / Math.max(1, t.total) * 100).toFixed(1)}%</span></div>`).join('') || '<p class="usage-empty">通过连接方案启动 Agent 后，真实用量会出现在这里。</p>'}</div>
      <div class="usage-section-head"><h3>引擎用量</h3><span>缓存不重复计入总量</span></div><table class="usage-table"><thead><tr><th>引擎</th><th>请求</th><th>输入</th><th>输出</th><th>用量未知</th></tr></thead><tbody>${stats.engines.map(item => `<tr><td>${esc(labels[item.label] || item.label)}</td><td>${number(item.requests)}</td><td>${number(item.input)}</td><td>${number(item.output)}</td><td>${number(item.unknown)}</td></tr>`).join('') || '<tr><td colspan="5">还没有经过应用网关的请求。</td></tr>'}</tbody></table>
      <p class="usage-scope">统计范围：经本应用连接方案转发、且响应中包含 usage 的请求。CLI 原配置和已有会话未接入此统计；中断请求的用量可能不完整。仅保存计数、模型、引擎和时间，不保存提示词、回复或 API Key。${stats.error ? `<br><span class="usage-warning">${esc(stats.error)}</span>` : ''}</p>`;
  }
  function show() {
    showModal('Token 用量与统计', '查看真实请求用量、缓存命中与每天的活跃程度。', '<div id="usage-dashboard">正在读取本地用量…</div>', '<button class="button" data-action="connections">连接方案</button><button class="button primary" data-action="close-modal">关闭</button>', true);
    $('.modal').classList.add('usage-modal');
    if (latest) render(latest);
    timer?.(); timer = client.watch({ type: 'usage' }, result => { if (result.status === 'ready') { latest = result.value; render(latest); } else if (result.status === 'error' && $('#usage-dashboard')) $('#usage-dashboard').textContent = result.error; });
  }
  document.addEventListener('click', event => {
    const action = event.target.closest('button')?.dataset.action;
    if (action === 'usage') show();
    if (action === 'usage-refresh') refresh();
  });

  return { show, close() { timer?.(); timer = undefined; } };
};
