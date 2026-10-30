window.createCapabilityUI = ({ client, getState, getWorkspace, showModal, beginModalLoad, modalCurrent, toast, icon, esc, modalAction }) => {
  const $ = selector => document.querySelector(selector);
  let model = { servers: [], skills: [], bindings: [], agents: [] };
  const library = () => model;
  async function load() { model = await client.query({ type: 'capabilities' }); }
  let tab = 'servers', selectedId = '';
  const json = (selector, fallback) => { const value = $(selector)?.value.trim(); return value ? JSON.parse(value) : fallback; };
  const empty = text => `<p class="cap-empty">${text}</p>`;
  const choices = (kind, ids, prefix) => library()[kind].map(item => `<label class="cap-choice"><input type="checkbox" name="${prefix}" value="${esc(item.id)}" ${ids.includes(item.id) ? 'checked' : ''} ${kind === 'servers' && !item.enabled ? 'disabled' : ''}><span><strong>${esc(item.name)}</strong><small>${esc(kind === 'servers' ? `${item.transport.toUpperCase()} · ${item.enabled ? '可分配' : '全局已停用'}` : item.description || `版本 ${item.revision}`)}</small></span></label>`).join('') || empty(kind === 'servers' ? '还没有 MCP 服务。先在 MCP 标签页添加。' : '还没有 Skills。先导入包含 SKILL.md 的目录。');
  function editor() {
    const s = library().servers.find(s => s.id === selectedId) || { name: '', transport: 'stdio', command: '', args: [], disabledTools: [], enabled: true, isolation: 'session' };
    return `<div class="cap-editor"><div class="cap-section-heading"><h3>${selectedId ? esc(s.name) : '添加 MCP 服务'}</h3><label class="cap-inline"><input type="checkbox" id="cap-enabled" ${s.enabled ? 'checked' : ''}>全局启用</label></div>
      <label class="form-label" for="cap-name">名称</label><input id="cap-name" class="text-input" maxlength="80" value="${esc(s.name)}" placeholder="例如：项目文件、浏览器、设计工具">
      <div class="cap-form-grid"><div><label class="form-label" for="cap-transport">连接方式</label><select id="cap-transport" class="text-input"><option value="stdio" ${s.transport === 'stdio' ? 'selected' : ''}>本地命令 · stdio</option><option value="http" ${s.transport === 'http' ? 'selected' : ''}>Streamable HTTP</option><option value="sse" ${s.transport === 'sse' ? 'selected' : ''}>SSE</option></select></div><div><label class="form-label" for="cap-isolation">进程隔离</label><select id="cap-isolation" class="text-input"><option value="session">每个 Agent 独立</option><option value="workspace" ${s.isolation === 'workspace' ? 'selected' : ''}>同工作区共享</option></select></div></div>
      <div id="cap-local" ${s.transport !== 'stdio' ? 'hidden' : ''}><label class="form-label" for="cap-command">启动命令</label><input id="cap-command" class="text-input" value="${esc(s.command || '')}" placeholder="例如 npx 或可执行文件完整路径"><label class="form-label" for="cap-args">参数 · JSON 数组</label><textarea id="cap-args" class="text-input cap-code" rows="2">${esc(JSON.stringify(s.args || []))}</textarea></div>
      <div id="cap-remote" ${s.transport === 'stdio' ? 'hidden' : ''}><label class="form-label" for="cap-url">服务地址</label><input id="cap-url" class="text-input" value="${esc(s.url || '')}" placeholder="http://127.0.0.1:3000/mcp"></div>
      <details class="cap-advanced"><summary>环境变量、认证与工具控制</summary><label class="form-label" for="cap-env">环境变量 · JSON 对象</label><textarea id="cap-env" class="text-input cap-code" rows="2" placeholder="留空保留已有值；填写 {} 清空"></textarea><small>已保存：${esc((s.envKeys || []).join(', ') || '无')}。值由系统加密，不回显。</small><label class="form-label" for="cap-headers">HTTP Headers · JSON 对象</label><textarea id="cap-headers" class="text-input cap-code" rows="2" placeholder='{"Authorization":"Bearer …"}'></textarea><small>已保存：${esc((s.headerKeys || []).join(', ') || '无')}。认证请填写在这里，不要放入 URL。</small><label class="form-label" for="cap-disabled">禁用工具 · JSON 名称数组</label><textarea id="cap-disabled" class="text-input cap-code" rows="2">${esc(JSON.stringify(s.disabledTools || []))}</textarea></details>
      <div id="cap-test-result" class="cap-test-result" role="status">保存后可测试连接，只读取工具列表，不执行工具。</div><div class="cap-tool-list" id="cap-tools"></div>
      <div class="cap-editor-actions">${selectedId ? '<button class="button cap-danger" data-cap-action="remove-server">移除服务</button><button class="button" data-cap-action="test">测试连接</button>' : ''}<button class="button primary" data-cap-action="save-server">保存服务</button></div><p class="cap-note">配置修改供新会话使用；全局停用和工具禁用立即阻止后续调用。已有 CLI 配置会保留。</p></div>`;
  }
  function skills() {
    return `<div class="cap-skill-import"><div><h3>集中管理，按需读取</h3><p>导入完整 Skill 目录，保留脚本与资源。各 Agent 通过统一入口发现并读取，内容不会一次性塞进提示词。</p></div><label class="form-label" for="cap-skill-dir">Skill 目录</label><div class="directory-row"><input id="cap-skill-dir" class="text-input" placeholder="选择包含 SKILL.md 的目录"><button data-browse="cap-skill-dir">选择目录</button></div><button class="button primary" data-cap-action="import-skill">${icon('plus')} 导入 Skill</button></div><div class="cap-skill-list">${library().skills.map(s => `<article class="cap-skill"><div class="cap-skill-mark">${icon('code')}</div><div><h3>${esc(s.name)}</h3><p>${esc(s.description || '暂无描述')}</p><small>版本 ${s.revision} · ${s.files} 个文件 · ${esc(s.hash.slice(0, 10))}</small><small class="cap-source">${esc(s.source)}</small></div><div class="cap-row-actions"><button class="button" data-cap-update="${esc(s.id)}">更新快照</button><button class="button" data-cap-remove-skill="${esc(s.id)}">移除</button></div></article>`).join('') || empty('导入第一个 Skill，再到「工作区分配」中启用。')}</div><p class="cap-note">更新会生成新版本；已有会话继续使用原快照。移除不删除源文件，也不改动 CLI 全局 Skills。</p>`;
  }
  function assignment(workspaceId) {
    const binding = library().bindings.find(b => b.workspaceId === workspaceId) || { serverIds: [], skillIds: [] };
    return `<div class="cap-assignment-head"><div><h3>工作区默认能力</h3><p>新 Agent 默认继承这里的选择；启动时仍可为单个 Agent 调整。</p></div><select id="cap-workspace" class="text-input">${getState().workspaces.map(w => `<option value="${esc(w.id)}" ${w.id === workspaceId ? 'selected' : ''}>${esc(w.title)}</option>`).join('')}</select></div><div class="cap-assign-grid"><section><h3>MCP 服务</h3>${choices('servers', binding.serverIds, 'cap-server')}</section><section><h3>Skills</h3>${choices('skills', binding.skillIds, 'cap-skill')}</section></div><div class="cap-editor-actions"><button class="button primary" data-cap-action="save-binding">保存工作区分配</button></div><p class="cap-note">对新启动的会话生效。当前运行中的 Agent 保留原分配；在启动器选择「本次不使用」即可关闭继承。</p>`;
  }
  async function show(nextTab = tab, nextId = selectedId, workspaceId = getWorkspace()?.id) {
    const current = beginModalLoad();
    try { await load(); } catch (error) { toast(error.message); return; }
    if (!current()) return;
    tab = nextTab; selectedId = nextId;
    showModal('能力库', '统一维护 MCP 和 Skills，让每个 Agent 带着需要的能力进入工作区。', `<div class="cap-tabs" role="tablist" aria-label="能力类型">${[['servers', 'MCP 服务', library().servers.length], ['skills', 'Skills', library().skills.length], ['assignment', '工作区分配', null]].map(([id, label, count]) => `<button role="tab" aria-selected="${tab === id}" tabindex="${tab === id ? 0 : -1}" data-cap-tab="${id}">${label}${count == null ? '' : `<span>${count}</span>`}</button>`).join('')}</div>${library().error ? `<p class="cap-error" role="alert">${esc(library().error)}</p>` : ''}<div class="cap-body">${tab === 'servers' ? `<div class="cap-layout"><aside class="cap-sidebar"><button class="button" data-cap-action="new-server">${icon('plus')} 添加 MCP</button>${library().servers.map(s => `<button class="cap-server-item ${s.id === selectedId ? 'selected' : ''}" data-cap-server="${esc(s.id)}"><strong>${esc(s.name)}</strong><small>${s.enabled ? s.transport.toUpperCase() : '已停用'} · ${s.isolation === 'workspace' ? '工作区共享' : '会话独立'}</small></button>`).join('') || empty('添加本地或远程 MCP 服务。')}<p class="cap-note">${library().secureStorageAvailable ? '凭证由系统加密保存' : '当前无法保存敏感环境变量和认证 Headers'}</p></aside>${editor()}</div>` : tab === 'skills' ? skills() : assignment(workspaceId)}</div>`, '<button class="button" data-action="close-modal">关闭</button>', true);
    $('.modal').classList.add('capability-modal');
    $('.cap-body').id = 'cap-panel'; $('.cap-body').setAttribute('role', 'tabpanel'); $('.cap-body').setAttribute('aria-labelledby', `cap-tab-${tab}`);
    document.querySelectorAll('[data-cap-tab]').forEach(button => { button.id = `cap-tab-${button.dataset.capTab}`; button.setAttribute('aria-controls', 'cap-panel'); });
  }
  function decorateLaunch() {
    $('#agent-tag').insertAdjacentHTML('afterend', `<section class="cap-launch"><div class="form-label-row"><label class="form-label" for="launch-cap-mode">本次能力</label><button class="text-link" data-action="capabilities">管理能力库 ${icon('arrow')}</button></div><select id="launch-cap-mode" class="text-input"><option value="workspace">继承工作区默认</option><option value="custom">自定义本次 Agent</option><option value="off">本次不使用</option></select><div id="launch-cap-summary" class="cap-note"></div><div id="launch-cap-choices" hidden></div></section>`);
    const current = modalCurrent(); void load().then(() => { if (current()) updateLaunch(); }).catch(error => { if (current()) toast(error.message); });
  }
  function updateLaunch() {
    if (!$('#launch-cap-mode')) return;
    const normalize = value => value?.replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase();
    const workspace = getState().workspaces.find(w => normalize(w.directory) === normalize($('#agent-directory').value));
    const binding = library().bindings.find(b => b.workspaceId === workspace?.id) || { serverIds: [], skillIds: [] };
    const mode = $('#launch-cap-mode').value;
    $('#launch-cap-summary').textContent = mode === 'off' ? '此次不加载能力库中的 MCP 或 Skills；CLI 自带能力不受影响。' : `${binding.serverIds.length} 个 MCP · ${binding.skillIds.length} 个 Skill 默认分配。Skills 通过 MCP 按需读取。`;
    $('#launch-cap-choices').hidden = mode !== 'custom';
    if (mode === 'custom' && !$('#launch-cap-choices').innerHTML) $('#launch-cap-choices').innerHTML = `<h4>MCP 服务</h4>${choices('servers', binding.serverIds, 'launch-cap-server')}<h4>Skills</h4>${choices('skills', binding.skillIds, 'launch-cap-skill')}`;
  }
  const selected = name => [...document.querySelectorAll(`input[name="${name}"]:checked:not(:disabled)`)].map(input => input.value);
  document.addEventListener('click', event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.action === 'capabilities') return show('servers', '');
    if (button.dataset.capTab) return show(button.dataset.capTab, '');
    if (button.dataset.capServer) return show('servers', button.dataset.capServer);
    if (button.dataset.capUpdate) return modalAction(button, async () => { const skill = library().skills.find(s => s.id === button.dataset.capUpdate); await client.dispatch({ type: 'importSkill', key: crypto.randomUUID(), id: skill.id, directory: skill.source }); if (!button.isConnected) return; show('skills'); toast('已生成新的 Skill 快照，新会话使用更新版本。'); });
    if (button.dataset.capRemoveSkill) return modalAction(button, async () => { await client.dispatch({ type: 'removeCapability', key: crypto.randomUUID(), kind: 'skills', id: button.dataset.capRemoveSkill }); if (!button.isConnected) return; show('skills'); toast('已移除，源目录和已有会话快照保留。'); });
    const action = button.dataset.capAction;
    if (action === 'new-server') return show('servers', '');
    if (action === 'save-server') return modalAction(button, async () => {
      const payload = { ...(selectedId ? { id: selectedId } : {}), name: $('#cap-name').value, transport: $('#cap-transport').value, command: $('#cap-command').value, args: json('#cap-args', []), url: $('#cap-url').value, enabled: $('#cap-enabled').checked, isolation: $('#cap-isolation').value, disabledTools: json('#cap-disabled', []) };
      for (const key of ['env', 'headers']) if ($(`#cap-${key}`).value.trim()) payload[key] = json(`#cap-${key}`, {});
      const result = await client.dispatch({ type: 'saveCapabilityServer', key: crypto.randomUUID(), server: payload }); if (!button.isConnected) return; await show('servers', result.entityId); toast('MCP 服务已保存。可测试连接，再分配给工作区。');
    });
    if (action === 'remove-server') return modalAction(button, async () => { await client.dispatch({ type: 'removeCapability', key: crypto.randomUUID(), kind: 'servers', id: selectedId }); if (!button.isConnected) return; show('servers', ''); toast('服务已移除，后续调用已阻止。'); });
    if (action === 'test') return modalAction(button, async () => {
      const target = $('#cap-test-result');
      const result = await client.query({ type: 'testCapabilityServer', id: selectedId, workspaceId: getWorkspace()?.id });
      if (!target?.isConnected) return;
      target.textContent = result.message;
      const disabled = json('#cap-disabled', []);
      $('#cap-tools').innerHTML = result.tools.map(t => `<label class="cap-choice"><input type="checkbox" data-cap-tool="${esc(t.name)}" ${disabled.includes(t.name) ? '' : 'checked'}><span><strong>${esc(t.name)}</strong><small>${esc(t.description)}</small></span></label>`).join('');
    });
    if (action === 'import-skill') return modalAction(button, async () => { await client.dispatch({ type: 'importSkill', key: crypto.randomUUID(), directory: $('#cap-skill-dir').value }); if (!button.isConnected) return; show('skills'); toast('Skill 已导入。到工作区分配中启用。'); });
    if (action === 'save-binding') return modalAction(button, async () => { const workspaceId = $('#cap-workspace').value; await client.dispatch({ type: 'bindCapabilities', key: crypto.randomUUID(), workspaceId, serverIds: selected('cap-server'), skillIds: selected('cap-skill') }); if (!button.isConnected) return; show('assignment', '', workspaceId); toast('已保存，新 Agent 会继承此分配。'); });
  });
  document.addEventListener('change', event => {
    if (event.target.id === 'cap-transport') { $('#cap-local').hidden = event.target.value !== 'stdio'; $('#cap-remote').hidden = event.target.value === 'stdio'; }
    if (event.target.id === 'cap-workspace') show('assignment', '', event.target.value);
    if (event.target.id === 'launch-cap-mode') updateLaunch();
    if (event.target.dataset.capTool !== undefined) {
      const previous = json('#cap-disabled', []), shown = [...document.querySelectorAll('[data-cap-tool]')].map(e => e.dataset.capTool);
      $('#cap-disabled').value = JSON.stringify([...previous.filter(name => !shown.includes(name)), ...[...document.querySelectorAll('[data-cap-tool]:not(:checked)')].map(e => e.dataset.capTool)]);
    }
  });
  document.addEventListener('input', event => { if (event.target.id === 'agent-directory') { const choices = $('#launch-cap-choices'); if (choices) choices.innerHTML = ''; updateLaunch(); } });
  document.addEventListener('keydown', event => {
    if (event.target?.dataset?.capTab && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault(); const ids = ['servers', 'skills', 'assignment']; let index = ids.indexOf(tab);
      index = event.key === 'Home' ? 0 : event.key === 'End' ? 2 : (index + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
      void show(ids[index], '').then(() => requestAnimationFrame(() => { if (tab === ids[index]) document.querySelector(`[data-cap-tab="${ids[index]}"]`)?.focus(); }));
    }
  });
  return { watch(onChange) { return client.watch({ type: 'capabilities' }, result => { if (result.status === 'ready') { model = result.value; onChange(); } }); }, show, decorateLaunch, updateLaunch, launchPayload: () => ({ capabilities: { mode: $('#launch-cap-mode')?.value || 'workspace', serverIds: selected('launch-cap-server'), skillIds: selected('launch-cap-skill') } }),
    member: agent => { const assigned = model.agents.find(a => a.agentId === agent.id); return assigned ? `<div class="member-capabilities"><span>${assigned.servers.length} MCP · ${assigned.skills.length} Skills</span><small>${esc([...assigned.servers.map(s => `${s.name}${s.enabled ? '' : '（已停用）'}`), ...assigned.skills.map(s => s.name)].join('、'))}</small><small>${assigned.status === 'connected' ? '已连接能力库' : assigned.status === 'stopped' ? '能力连接已停止' : '已分配，等待引擎连接'}${assigned.errors.length ? ` · ${esc(assigned.errors.join('、'))} 连接异常` : ''}</small></div>` : ''; } };
};
