/* Shared approval UI consumes only the public Client contract. */
window.createPermissionUI = ({ client, esc, toast }) => {
  const dialog = document.createElement('dialog');
  dialog.className = 'permission-dialog';
  dialog.setAttribute('aria-labelledby', 'permission-title');
  document.body.append(dialog);
  const badge = document.createElement('button');
  badge.className = 'permission-inbox button'; badge.hidden = true;
  document.body.append(badge);
  let queue = [], active = null, busy = false, live = false;
  function updateActions() {
    if (!active) return;
    for (const button of dialog.querySelectorAll('[data-rpc-decision]')) button.disabled = busy || !live || completed.has(keyOf(active)) || !active.request.allowedDecisions.includes(button.dataset.rpcDecision);
  }
  const deferred = new Set(), completed = new Set(), drafts = new Map();
  const keyOf = item => `${item.agent.id}:${item.request.id}`;
  const close = () => { if (dialog.open) dialog.close(); dialog.innerHTML = ''; active = null; };
  function postpone() { if (active) { const key = keyOf(active); deferred.add(key); drafts.set(key, [...dialog.querySelectorAll('input,textarea,select')].map(el => ({ value: el.value, checked: el.checked }))); } close(); advance(); }
  dialog.addEventListener('cancel', e => { e.preventDefault(); if (!busy) postpone(); });
  // Native dialog owns focus trapping; do not let the legacy modal handler intervene.
  dialog.addEventListener('keydown', e => e.stopPropagation());
  badge.onclick = () => { deferred.clear(); advance(); };
  function advance() {
    if (active || busy) return;
    const next = queue.find(item => !deferred.has(keyOf(item)) && !completed.has(keyOf(item)));
    if (next) show(next);
  }
  function show(item) {
    active = item;
    const { agent, request: r } = item;
    const questions = r.questions || [];
    const detail = r.summary;
    const fields = r.kind === 'questions' ? questions.map((q, i) => `<fieldset data-question="${i}"><legend>${esc(q.title || q.id)}</legend>${(q.options || []).map((o, j) => `<label class="permission-option"><input type="${q.multiple ? 'checkbox' : 'radio'}" name="question-${i}" value="${esc(typeof o === 'string' ? o : o.label)}"><span>${esc(typeof o === 'string' ? o : o.label)}<small>${esc(o.description || '')}</small></span></label>`).join('')}<input class="text-input" data-custom-answer placeholder="填写回答，或补充其他选项" aria-label="${esc(q.title || '回答')}" maxlength="4000"></fieldset>`).join('') : r.kind === 'input' ? `<label for="permission-value">${esc(r.title || '请输入')}</label>${r.options?.length ? `<select id="permission-value" class="text-input">${(r.options || []).map(o => `<option>${esc(o)}</option>`).join('')}</select>` : '<textarea id="permission-value" class="text-input" maxlength="16000"></textarea>'}` : '';
    dialog.innerHTML = `<div class="permission-heading"><h2 id="permission-title">${r.kind === 'permission' ? '操作需要确认' : 'Agent 需要你的回答'}</h2><button class="button" data-later>稍后处理</button></div><p>${esc(agent.displayName || agent.name)} · ${esc(r.engine || agent.label || agent.tool)}</p><p class="permission-context">工作目录：${esc(r.directory || agent.directory || '未知')}<br>会话：${esc(r.roomId || '初始化')}</p><strong>${esc(r.title || '操作确认')}</strong><pre class="rpc-request-detail">${esc(detail)}</pre>${fields}<p class="form-hint">${r.kind === 'permission' ? (r.scopeLabel === '当前任务轮次' ? '此权限由引擎授予当前任务轮次；任务结束后失效。' : '仅处理本次确认，不创建永久授权规则。') : '回答只发送给当前请求的 Agent。'} 稍后处理不会允许操作。</p><p class="permission-error" role="alert"></p><div class="permission-actions"><button class="button" data-rpc-decision="deny">${r.kind === 'permission' ? '拒绝' : '取消'}</button><button class="button primary" data-rpc-decision="allow">${r.kind === 'permission' ? r.scopeLabel === '当前任务轮次' ? '允许本轮' : '允许本次' : '提交回答'}</button></div>`;
    dialog.querySelector('[data-later]').onclick = postpone;
    dialog.querySelectorAll('[data-rpc-decision]').forEach(button => { button.onclick = () => respond(button.dataset.rpcDecision === 'allow'); });
    const draft = drafts.get(keyOf(item));
    if (draft) [...dialog.querySelectorAll('input,textarea,select')].forEach((el, i) => { if (draft[i]) { el.value = draft[i].value; el.checked = draft[i].checked; } });
    if (!dialog.open) dialog.showModal();
    updateActions();
    dialog.querySelector('[data-rpc-decision="deny"]').focus();
  }
  async function respond(allow) {
    if (busy || !active || !live || completed.has(keyOf(active)) || !active.request.allowedDecisions.includes(allow ? 'allow' : 'deny')) return;
    const item = active, key = keyOf(item);
    const answers = [...dialog.querySelectorAll('[data-question]')].map(field => {
      const custom = field.querySelector('[data-custom-answer]').value.trim();
      const selected = [...field.querySelectorAll('input:checked')].map(input => input.value);
      const multi = Boolean(field.querySelector('input[type="checkbox"]'));
      return custom ? multi ? [...selected, custom] : [custom] : selected;
    });
    if (allow && answers.some(a => !a.length)) { dialog.querySelector('.permission-error').textContent = '请回答每个问题后再提交。'; return; }
    const answer = { allow, cancelled: !allow, scope: 'once', answers, value: dialog.querySelector('#permission-value')?.value };
    busy = true;
    dialog.querySelectorAll('button,input,select,textarea').forEach(el => { el.disabled = true; });
    try {
      await client.dispatch({ type: 'decide', approvalId: item.request.id, expectedRevision: item.request.revision, allow, answers, value: answer.value || '' });
      completed.add(key); close(); toast(allow ? '已提交本次确认' : '已拒绝或取消本次请求');
      sync(client.read());
    } catch (error) {
      toast(error.message);
      try { sync(client.read()); } catch { /* Keep the current request visible on read failure. */ }
      if (active && keyOf(active) === key) {
        dialog.querySelector('.permission-error').textContent = error.message;
        dialog.querySelectorAll('button,input,select,textarea').forEach(el => { el.disabled = error.outcome === 'unknown' && !el.hasAttribute('data-later'); });
        if (error.outcome === 'unknown') completed.add(key);
      }
    } finally { busy = false; updateActions(); advance(); }
  }
  function sync(state) {
      live = state.connection === 'live';
      queue = state.approvals.filter(request => request.status === 'pending' && request.delivery === 'pending').map(request => ({ agent: state.agents.find(a => a.id === request.agentId) || { id: request.agentId }, request }));
      const keys = new Set(queue.map(keyOf));
      for (const key of drafts.keys()) if (!keys.has(key)) drafts.delete(key);
      for (const set of [deferred, completed]) for (const key of set) if (!keys.has(key)) set.delete(key);
      badge.hidden = queue.length === 0;
      badge.textContent = `待确认 · ${queue.length}`;
      if (active && !keys.has(keyOf(active))) { if (!busy) toast('确认请求已结束或失效'); close(); }
      advance();
      updateActions();
    }
  return { sync,
    open(agentId) {
      const item = queue.find(item => !agentId || item.agent.id === agentId);
      if (!item) return toast('当前没有待处理的确认');
      if (busy) return;
      close(); deferred.delete(keyOf(item)); show(item);
    },
  };
};
