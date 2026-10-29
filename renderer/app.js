/* Agent Room renderer. The bridge is the only boundary to the local machine. */
(() => {
  const $ = selector => document.querySelector(selector);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const icon = window.icon;
  const storage = { get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } }, set(key, value) { localStorage.setItem(key, JSON.stringify(value)); } };
  const html = (selector, value) => { const element = $(selector); if (element.dataset.rendered !== value) { element.innerHTML = value; element.dataset.rendered = value; } };
  let theme = storage.get('ar-theme', 'light');
  let sidebarCollapsed = storage.get('ar-sidebar-collapsed', false);
  function applyTheme() {
    document.documentElement.dataset.theme = theme;
    const button = $('.theme-toggle');
    button.innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
    button.title = button.ariaLabel = theme === 'dark' ? '切换到浅色' : '切换到深色';
  }
  function applySidebar() {
    document.body.classList.toggle('sidebar-collapsed', sidebarCollapsed);
    $('.sidebar').inert = sidebarCollapsed;
    if (sidebarCollapsed) $('#workspace-menu').hidden = true;
  }
  applyTheme(); applySidebar();
  const portraits = window.AgentAvatars.create({ saved: storage.get('ar-agent-avatars', {}) });
  let avatarRevision = 0;
  async function http(route, payload) {
    const response = await fetch(`/api/${route}`, payload === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '连接失败');
    return result;
  }
  const bridge = window.agentRoom || {
    desktop: false, getState: () => http('state'), refresh: () => http('refresh', {}),
    send: payload => http('send', payload), createRoom: payload => http('rooms', payload),
    createWorkspace: payload => http('workspaces', payload), terminal: id => http('terminal', { id }),
    inspectSession: id => http('session/inspect', { id }), respondSession: (id, requestId, answer) => http('session/respond', { id, requestId, answer }),
    cancelSession: id => http('session/cancel', { id }), stopSession: id => http('session/stop', { id }),
    saveConnection: payload => http('connections/save', payload), removeConnection: id => http('connections/remove', { id }),
    testConnection: payload => http('connections/test', payload), chooseCertificate: async () => null,
    getUsage: () => http('usage'),
    saveCapabilityServer: payload => http('capabilities/server-save', payload), importCapabilitySkill: payload => http('capabilities/skill-import', payload),
    removeCapability: payload => http('capabilities/remove', payload), bindCapabilities: payload => http('capabilities/bind', payload), testCapabilityServer: payload => http('capabilities/test', payload),
    launch: payload => http('launch', payload), chooseDirectory: async () => null,
    openSource: () => window.open('https://github.com/aannoo/hcom', '_blank', 'noopener'),
    onState: callback => { const stream = new EventSource('/api/events'); stream.onmessage = event => callback(JSON.parse(event.data)); return () => stream.close(); },
  };
  if (!bridge.desktop) $('.window-controls').hidden = true;
  let state = { connection: 'connecting', agents: [], rooms: [], workspaces: [], messages: [], engines: [] };
  let workspace = storage.get('ar-workspace', '');
  let active = storage.get('ar-room', '');
  let filter = 'all';
  let query = '';
  let details = storage.get('ar-details', true);
  let sending = false;
  let mentionIndex = 0;
  let mentionItems = [];
  let drafts = {};
  let expanded = new Set();
  let renderedMessageKey = '';
  let lastSeen = storage.get('ar-seen', {});
  let modalReturnFocus;
  let terminalTimer;
  let toastTimer;
  const input = $('#message-input');

  const currentWorkspace = () => state.workspaces.find(item => item.id === workspace);
  const workspaceAgents = () => state.agents.filter(agent => agent.workspaceId === workspace);
  const groupRooms = () => state.rooms.filter(room => room.workspaceId === workspace);
  const directRooms = () => workspaceAgents().map(agent => ({ id: `dm:${agent.id}`, title: agent.displayName, thread: `agent-room-dm-${agent.id}`, type: 'dm', members: [agent.id], workspaceId: workspace, agent }));
  const rooms = () => [...groupRooms(), ...directRooms()];
  const currentRoom = () => rooms().find(room => room.id === active);
  const membersOf = room => !room ? [] : workspaceAgents().filter(agent => room.allMembers || room.members?.includes(agent.id));
  const messagesOf = room => !room ? [] : state.messages.filter(message => message.thread === room.thread);
  const statusLabel = status => ({ listening: '空闲', active: '会话活跃', blocked: '待确认', inactive: '已离线', unknown: '连接中' })[status] || '连接中';
  const initials = tool => ({ pi: 'π', omp: 'π', human: 'Z', gemini: '✦', opencode: 'O', kimi: 'K', cursor: 'C', copilot: 'G', grok: 'x', hermes: 'H', qoder: 'Q', kilo: 'K' })[tool];
  function avatar(agent = {}, size = '', presence = false) {
    const tool = agent.tool || 'group';
    const portrait = tool === 'human' || tool === 'group' ? null : portraits.get(agent);
    const graphic = portrait ? `<img src="${portrait.src}" alt="" draggable="false" width="256" height="256">` : tool === 'claude' ? icon('sun') : tool === 'codex' ? icon('code') : tool === 'group' ? icon('agents') : esc(initials(tool) || agent.label?.slice(0, 1) || 'A');
    return `<span class="avatar ${esc(tool)} ${size}${portrait ? ' character' : ''}" aria-hidden="true">${graphic}${presence ? `<i class="status-dot ${esc(agent.status)}"></i>` : ''}</span>`;
  }
  function mosaic(members) {
    if (!members.length) return avatar({ tool: 'group' });
    return `<span class="group-mosaic">${Array.from({ length: 4 }, (_, index) => avatar(members[index % members.length])).join('')}</span>`;
  }
  function stack(members, max = 4) { return `<span class="avatar-stack">${members.slice(0, max).map(agent => avatar(agent, 'small')).join('')}</span>`; }
  function clock(timestamp) {
    const date = new Date(timestamp);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  }
  function formatText(text) {
    return esc(text).replace(/`([^`\n]+)`/g, '<code>$1</code>').replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|\s)(@[a-zA-Z0-9][a-zA-Z0-9_-]*)/g, '$1<span class="mention">$2</span>');
  }
  function unread(room) { return messagesOf(room).filter(message => !message.human && Number(message.id) > (lastSeen[room.id] || 0)).length; }
  function markSeen() {
    const room = currentRoom();
    const last = messagesOf(room).at(-1);
    if (last) { lastSeen[room.id] = Number(last.id); storage.set('ar-seen', lastSeen); }
  }
  function receive(next) {
    state = next;
    if (portraits.sync(state.agents)) {
      storage.set('ar-agent-avatars', portraits.export());
      avatarRevision++;
    }
    if (!state.workspaces.some(item => item.id === workspace)) workspace = state.workspaces[0]?.id || '';
    if (!rooms().some(room => room.id === active)) active = groupRooms()[0]?.id || '';
    markSeen();
    render();
  }
  function selectRoom(id) {
    drafts[active] = input.value;
    active = id;
    storage.set('ar-room', active);
    input.value = drafts[active] || '';
    $('#mention-menu').hidden = true;
    renderedMessageKey = '';
    markSeen(); render(); updateComposer(); input.focus();
  }
  function selectWorkspace(id) {
    drafts[active] = input.value;
    workspace = id;
    storage.set('ar-workspace', workspace);
    active = groupRooms()[0]?.id || '';
    storage.set('ar-room', active);
    input.value = drafts[active] || '';
    query = ''; $('#search').value = ''; filter = 'all';
    $('#workspace-menu').hidden = true;
    renderedMessageKey = ''; markSeen(); render(); updateComposer();
  }
  function render() {
    $('#workspace-name').textContent = currentWorkspace()?.title || '我的工作区';
    $('#workspace-subtitle').textContent = `${workspaceAgents().length} 个 Agent · ${groupRooms().length} 个群聊`;
    $('#connection-text').textContent = state.connection === 'connected' ? `hcom 已连接 · ${state.agents.length} 个会话` : state.connection === 'connecting' ? '正在连接 hcom…' : 'hcom 连接已断开';
    $('.connection-line').classList.toggle('offline', state.connection === 'disconnected');
    $('#connection-alert').hidden = state.connection !== 'disconnected';
    $('#connection-alert').textContent = state.error || '连接已断开，输入内容会保留。';
    document.querySelectorAll('[data-filter]').forEach(button => { const selected = button.dataset.filter === filter; button.classList.toggle('selected', selected); button.setAttribute('aria-selected', String(selected)); });
    renderSidebar(); renderHeader(); renderMessages(); renderDetails(); updateComposer();
  }
  function renderSidebar() {
    const isVisible = room => {
      if (filter === 'unread' && !unread(room)) return false;
      if (filter === 'group' && room.type !== 'group') return false;
      if (filter === 'dm' && room.type !== 'dm') return false;
      return !query || `${room.title} ${room.agent?.tag || ''} ${membersOf(room).map(agent => agent.name).join(' ')}`.toLowerCase().includes(query.toLowerCase());
    };
    function item(room) {
      const messages = messagesOf(room);
      const last = messages.at(-1);
      const count = unread(room);
      const members = membersOf(room);
      const preview = last ? `${last.human ? '你' : last.senderName.split(' · ')[0]}：${last.text}` : room.agent ? `${statusLabel(room.agent.status)}${room.agent.tag ? ` · #${room.agent.tag}` : ''} · ${room.agent.label}` : room.description;
      return `<button class="conversation-item ${room.id === active ? 'selected' : ''}" data-room="${esc(room.id)}" aria-label="${esc(room.title + (room.agent ? `，${window.AgentContext.describe(room.agent.context)}` : ''))}" ${room.id === active ? 'aria-current="page"' : ''}>${room.agent ? avatar(room.agent, '', true) : `<span class="group-icon">${icon(room.pinned ? 'chat' : 'chats')}</span>`}<span class="conversation-content"><span class="conversation-top"><span class="conversation-title">${esc(room.title)}</span>${room.pinned ? icon('pin', 'mini-pin') : ''}<span class="conversation-time">${last ? clock(last.timestamp) : ''}</span></span><span class="conversation-preview">${room.agent ? window.AgentContext.render(room.agent.context) : ''}<span class="preview-text">${esc(preview)}</span>${count ? `<span class="unread-badge">${count > 9 ? '9+' : count}</span>` : ''}</span></span></button>`;
    }
    const pinned = groupRooms().filter(room => room.pinned && isVisible(room));
    const other = groupRooms().filter(room => !room.pinned && isVisible(room));
    const people = directRooms().filter(isVisible);
    let html = '';
    if (pinned.length) html += `<div class="section-label">置顶对话</div>${pinned.map(item).join('')}`;
    if (other.length) html += `<div class="section-label">群聊 <button data-action="new-room" aria-label="新建群聊">+</button></div>${other.map(item).join('')}`;
    if (people.length) html += `<div class="section-label">工作区成员 <span>${workspaceAgents().length}</span></div>${people.map(item).join('')}`;
    const nextHtml = html || `<div class="list-empty">${query ? '没有匹配的会话或成员' : filter === 'unread' ? '没有未读消息' : '暂无会话，先添加一个 Agent。'}</div>`;
    if ($('#conversation-list').dataset.rendered !== nextHtml) { $('#conversation-list').innerHTML = nextHtml; $('#conversation-list').dataset.rendered = nextHtml; }
    const total = rooms().reduce((sum, room) => sum + unread(room), 0);
    $('#unread-total').hidden = !total; $('#unread-total').textContent = total;
  }
  function renderHeader() {
    const room = currentRoom();
    const members = membersOf(room);
    html('#conversation-header', `<div class="header-location"><button class="icon-button" data-action="toggle-sidebar" aria-label="${sidebarCollapsed ? '展开侧栏' : '收起侧栏'}" title="切换侧栏 · Ctrl B">${icon('panel-left')}</button><div><div class="header-title">${esc(room?.title || '协作大厅')}</div><div class="room-subtitle">${esc(currentWorkspace()?.title || '本地工作区')}<span class="subtitle-dot">/</span>${room?.agent ? `${esc(room.agent.label)} · ${esc(statusLabel(room.agent.status))}` : `${members.length} 个 Agent · 群聊`}</div></div></div><div class="header-actions">${room?.agent ? window.AgentContext.render(room.agent.context, false, true) : ''}${room?.agent ? `<button class="icon-button" data-terminal="${esc(room.agent.id)}" aria-label="查看会话" title="查看会话">${icon('terminal')}</button>` : `<button class="members-pill" data-action="launch">${icon('plus')} 添加 Agent</button>`}<button class="icon-button ${details ? 'selected' : ''}" data-action="members" title="工作区与成员" aria-label="工作区与成员" aria-expanded="${details}">${icon('panel-left')}</button></div>`);
  }
  function welcome(room) {
    const members = membersOf(room);
    return `<div class="welcome"><div class="welcome-mark">${icon('room-mark')}</div><div class="welcome-kicker">${esc(currentWorkspace()?.title || 'AGENT ROOM')} / ${room?.type === 'dm' ? 'DIRECT MESSAGE' : 'WORKSPACE'}</div><h2>${room?.type === 'dm' ? `和 ${esc(room.agent.label)} 一起开始。` : '今天，一起完成什么？'}</h2><p>${room?.type === 'dm' ? '描述任务，继续你们的独立对话。' : '一个问题，多个视角。让你的 Agent 在这里协作。<br>输入 @ 选择成员或标签，也可以向整个房间提问。'}</p><div class="welcome-members">${stack(members)}<span>${members.length ? `${members.length} 个 Agent 已加入当前房间` : '先添加一个 Agent，再开始对话'}</span></div><div class="quick-prompts"><button class="prompt-card" data-prompt="请一起梳理当前项目的目标、结构和下一步计划。">${icon('folder')}<strong>梳理项目</strong><small>目标、结构与下一步</small>${icon('arrow', 'prompt-arrow')}</button><button class="prompt-card" data-prompt="请从实现和维护两个角度讨论当前方案，给出建议。">${icon('agents')}<strong>讨论方案</strong><small>听听不同的视角</small>${icon('arrow', 'prompt-arrow')}</button><button class="prompt-card" data-prompt="请审阅当前代码改动，指出潜在问题和改进建议。">${icon('code')}<strong>审阅代码</strong><small>找出问题与改进点</small>${icon('arrow', 'prompt-arrow')}</button></div></div>`;
  }
  function renderMessages() {
    const room = currentRoom();
    const messages = messagesOf(room);
    const pending = membersOf(room).filter(a => a.rpc && (a.rpc.current?.thread === room?.thread || a.rpc.error));
    const key = `${active}:${messages.map(message => message.id).join(',')}:${[...expanded].join(',')}:${workspaceAgents().length}:${avatarRevision}:${JSON.stringify(pending.map(a => a.rpc))}`;
    if (key === renderedMessageKey) return;
    const container = $('#messages');
    const atBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 100;
    const changedRoom = !renderedMessageKey.startsWith(`${active}:`);
    renderedMessageKey = key;
    if (!messages.length && !pending.length) { container.innerHTML = welcome(room); return; }
    let lastDate = '';
    container.innerHTML = messages.map(message => {
      const date = new Date(message.timestamp);
      const dateKey = date.toLocaleDateString('zh-CN');
      const today = dateKey === new Date().toLocaleDateString('zh-CN');
      const divider = dateKey !== lastDate ? `<div class="date-divider">${today ? '今天' : esc(dateKey)}</div>` : '';
      lastDate = dateKey;
      const isLong = message.text.length > 420;
      const collapsed = isLong && !expanded.has(message.id);
      return `${divider}<article class="message ${message.human ? 'human' : ''}" id="message-${esc(message.id)}">${avatar(message.human ? { tool: 'human' } : state.agents.find(agent => agent.id === message.sender || agent.name === message.sender) || { id: message.sender, tool: message.tool })}<div class="message-main"><div class="message-heading"><span class="message-name">${esc(message.senderName)}</span><span class="message-engine">${message.human ? 'YOU' : esc(state.agents.find(agent => agent.id === message.sender)?.label || message.tool)}</span><span class="message-actions"><button data-copy-message="${esc(message.id)}">复制</button></span><time class="message-time">${clock(message.timestamp)}</time></div><div class="message-bubble ${collapsed ? 'collapsed' : ''}">${formatText(message.text)}</div>${isLong ? `<button class="expand-message" data-expand="${esc(message.id)}">${collapsed ? '展开完整消息' : '收起消息'}</button>` : ''}<div class="message-footer">${message.human ? `${icon('checkdouble')} 已发送${message.recipients.length ? ` · ${message.recipients.length} 位接收者` : ''}` : message.intent === 'ack' ? `${icon('check')} 已回应` : ''}${message.replyTo ? `<button class="reply-link" data-jump="${esc(message.replyTo)}">回复 #${esc(message.replyTo)}</button>` : ''}</div></div></article>`;
    }).join('') + pending.map(a => `<article class="message rpc-progress">${avatar(a)}<div class="message-main"><div class="message-heading"><span class="message-name">${esc(a.displayName)}</span><span class="message-engine">${esc(statusLabel(a.status))}${a.rpc.queueLength ? ` · ${a.rpc.queueLength} 条排队` : ''}</span></div><div class="message-bubble">${formatText(a.rpc.partial || a.rpc.error || (a.rpc.approvals.length ? '需要你的确认，等待处理。' : a.rpc.activity ? `正在执行 ${a.rpc.activity.kind}` : '正在思考…'))}</div><button class="expand-message" data-terminal="${esc(a.id)}">${a.rpc.approvals.length ? '处理确认' : '查看会话状态'}</button></div></article>`).join('');
    if (atBottom || changedRoom) container.scrollTop = container.scrollHeight;
  }
  function renderDetails() {
    const panel = $('#details-panel'); panel.hidden = !details;
    if (!details) return;
    const room = currentRoom(); const members = membersOf(room);
    const tags = [...new Set(members.map(agent => agent.tag).filter(Boolean))];
    html('#details-panel', `<div class="details-title">工作区与成员<button class="icon-button" data-action="members" aria-label="关闭详情">${icon('close')}</button></div><section class="context-card"><div class="context-heading">工作环境<span class="context-local">本机</span></div><div class="context-path">${icon('folder')}<span><strong>${esc(currentWorkspace()?.title || '本地工作区')}</strong><small>${esc(currentWorkspace()?.directory || '请选择工作目录')}</small></span></div><button class="context-switch" data-action="workspace-menu">切换工作区 ${icon('chevron-down')}</button></section><section class="context-card"><div class="context-summary"><span>当前会话</span><strong>${room?.type === 'dm' ? '私聊' : '群聊'}</strong></div><div class="context-summary"><span>房间成员</span><strong>${members.length} 个 Agent</strong></div><div class="context-summary"><span>消息记录</span><strong>${messagesOf(room).length} 条</strong></div></section><div class="details-section-title">房间成员</div>${members.map(agent => `<div class="member-card">${avatar(agent, 'small', true)}<div><strong>${esc(agent.displayName)}</strong><small class="member-tags">${esc(statusLabel(agent.status))}${agent.tag ? `<span class="tag-pill">#${esc(agent.tag)}</span>` : ''}</small></div><button class="icon-button" data-terminal="${esc(agent.id)}" title="${agent.mode === 'rpc' ? '会话状态与权限确认' : '应用内交互终端'}" aria-label="查看 ${esc(agent.displayName)} 的会话">${icon('terminal')}</button></div><div class="member-context">${window.AgentContext.render(agent.context, true)}${capabilities.member(agent)}</div>`).join('') || '<p class="detail-note">还没有成员。添加 Agent 时选择这个工作目录，会自动出现在这里。</p>'}<button class="detail-add-button" data-action="launch">${icon('plus')} 添加 Agent</button>${tags.length ? `<div class="details-section-title">按标签提及</div><div class="detail-tags">${tags.map(tag => `<button data-invite="${esc(tag)}">#${esc(tag)}</button>`).join('')}</div><p class="detail-note">点击标签插入 @ 提及，发送前可继续编辑消息。</p>` : ''}`);
  }
  function updateComposer() {
    $('#send-button').disabled = sending || !input.value.trim() || state.connection !== 'connected';
    html('#send-button', icon(sending ? 'refresh' : 'arrow-up'));
    $('#send-button').title = $('#send-button').ariaLabel = sending ? '发送中…' : '发送消息';
    const room = currentRoom();
    $('#routing-hint').textContent = room?.type === 'dm' ? `仅发送给 ${room.agent.label} · ${room.agent.baseName}` : '未 @ 时发送给房间内所有成员 · @ 可指定回应者';
    const members = membersOf(room);
    $('#composer-hint').textContent = room?.type === 'dm' ? room.agent.label : `${members.length} 位成员`;
    $('#composer-workspace').textContent = currentWorkspace()?.title || '选择工作区';
    $('#composer-workspace').parentElement.title = currentWorkspace()?.directory || '切换工作目录';
    const engines = [...new Set(members.map(agent => agent.label))];
    $('#composer-engines').textContent = engines.length > 2 ? `${engines[0]} + ${engines.length - 1} 种引擎` : engines.join(' · ') || '选择 Agent';
    input.style.height = 'auto';
    input.style.height = `${Math.min(180, Math.max(54, input.scrollHeight))}px`;
    // An hcom active state does not prove the model is generating.
    const activeAgents = members.filter(agent => agent.status === 'active');
    html('#typing-line', activeAgents.length ? `<span class="activity-dot"></span>${esc(activeAgents.map(agent => agent.displayName.split(' · ')[0]).join('、'))} · 会话活跃` : '');
  }
  function mentionContext() {
    const before = input.value.slice(0, input.selectionStart);
    const match = before.match(/(?:^|\s)@([a-zA-Z0-9_-]*)$/);
    return match ? { query: match[1], start: before.length - match[1].length - 1 } : null;
  }
  function renderMentions() {
    const context = mentionContext(); const menu = $('#mention-menu');
    if (!context) { menu.hidden = true; return; }
    const members = membersOf(currentRoom());
    const tags = [...new Set(members.map(agent => agent.tag).filter(Boolean))];
    mentionItems = [
      ...members.map(agent => ({ value: agent.name, title: agent.displayName, subtitle: `@${agent.name}`, agent })),
      ...tags.map(tag => ({ value: tag, title: `# ${tag}`, subtitle: `${members.filter(agent => agent.tag === tag).length} 位成员 · 按标签提及`, tag })),
    ].filter(item => `${item.value} ${item.title}`.toLowerCase().includes(context.query.toLowerCase()));
    if (!mentionItems.length) { menu.hidden = true; return; }
    mentionIndex = Math.min(mentionIndex, mentionItems.length - 1);
    menu.hidden = false;
    menu.innerHTML = `<div class="mention-heading">邀请谁来回应？</div>${mentionItems.map((item, index) => `<button class="mention-option ${index === mentionIndex ? 'highlighted' : ''}" role="option" aria-selected="${index === mentionIndex}" data-mention="${index}">${item.agent ? avatar(item.agent, 'small') : `<span class="avatar small group">${icon('tag')}</span>`}<span><strong>${esc(item.title)}</strong><small>${esc(item.subtitle)}</small></span><span class="mention-enter">↵</span></button>`).join('')}`;
  }
  function insertMention(index) {
    const context = mentionContext(); const item = mentionItems[index];
    if (!context || !item) return;
    const rest = input.value.slice(input.selectionStart);
    const prefix = input.value.slice(0, context.start);
    input.value = `${prefix}@${item.value} ${rest}`;
    const cursor = prefix.length + item.value.length + 2;
    input.focus(); input.setSelectionRange(cursor, cursor); $('#mention-menu').hidden = true; updateComposer();
  }
  function insertText(text) {
    const start = input.selectionStart; const end = input.selectionEnd;
    input.value = input.value.slice(0, start) + text + input.value.slice(end);
    input.focus(); input.setSelectionRange(start + text.length, start + text.length); updateComposer(); renderMentions();
  }
  async function send() {
    if (sending || !input.value.trim()) return;
    const roomId = active; const text = input.value;
    sending = true; updateComposer(); $('#mention-menu').hidden = true;
    try {
      const result = await bridge.send({ roomId, text });
      drafts[roomId] = '';
      if (active === roomId && input.value === text) input.value = '';
      receive(result.state); $('#messages').scrollTop = $('#messages').scrollHeight;
    } catch (error) { toast(error.message); }
    finally { sending = false; updateComposer(); input.focus(); }
  }
  function toast(text) {
    clearTimeout(toastTimer); $('#toast').textContent = text; $('#toast').hidden = false;
    toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 6500);
  }
  function showModal(title, subtitle, content, footer, wide = false) {
    const returnFocus = document.querySelector('.modal') ? modalReturnFocus : document.activeElement;
    closeModal(false); modalReturnFocus = returnFocus;
    $('#modal-root').innerHTML = `<div class="modal-backdrop"><section class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button class="icon-button" data-action="close-modal" aria-label="关闭窗口">${icon('close')}</button></div><p class="modal-subtitle">${esc(subtitle)}</p>${content}${footer ? `<div class="modal-actions">${footer}</div>` : ''}</section></div>`;
    requestAnimationFrame(() => $('#modal-root').querySelector('input,button:not(.icon-button),textarea')?.focus());
  }
  let terminalDispose;
  function closeModal(restore = true) { clearInterval(terminalTimer); terminalDispose?.(); terminalDispose = null; $('#modal-root').innerHTML = ''; if (restore) modalReturnFocus?.focus(); }
  const modalButtons = (label, action) => `<button class="button" data-action="close-modal">取消</button><button class="button primary" id="modal-submit" data-action="${action}">${esc(label)} ${icon('arrow')}</button>`;
  function showNewRoom() {
    const members = workspaceAgents();
    showModal('新建群聊', '选择当前工作区中的成员。同一个 Agent 可以加入多个群聊。', `<label class="form-label" for="room-name">房间名称</label><input class="text-input" id="room-name" maxlength="40" placeholder="例如：新想法讨论、代码审阅小组"><label class="form-label">邀请成员</label><div class="member-picker">${members.map(agent => `<label class="member-choice">${avatar(agent, 'small')}<span><strong>${esc(agent.displayName)}</strong><small>${esc(agent.label)}${agent.tag ? ` · #${esc(agent.tag)}` : ''}</small></span><input type="checkbox" name="room-member" value="${esc(agent.id)}" checked></label>`).join('') || '<div class="empty-state-small">先添加一位 agent，再创建群聊。</div>'}</div>`, modalButtons('创建房间', 'create-room'));
  }
  function showLaunch() {
    const engines = [...state.engines].sort((a, b) => Number(b.installed) - Number(a.installed));
    const primary = engines.filter(engine => ['codex', 'claude', 'pi', 'opencode'].includes(engine.id));
    const other = engines.filter(engine => !primary.includes(engine));
    const selected = primary.find(engine => engine.installed)?.id || primary[0]?.id;
    const option = engine => `<button class="engine-option ${engine.installed ? 'installed' : 'disabled'} ${engine.id === selected ? 'selected' : ''}" data-engine="${esc(engine.id)}" aria-pressed="${engine.id === selected}">${avatar({ tool: engine.id, label: engine.label }, 'small')}<span><strong>${esc(engine.label)}</strong><small>${engine.installed ? '本机已检测到' : '尚未检测到 CLI'}</small></span></button>`;
    showModal('启动 Agent', '通过 RPC 启动独立会话。回复、任务状态和权限确认都在此应用中完成。请先在 CLI 中完成账号登录，或选择连接方案。', `<label class="form-label">选择 Agent 引擎</label><div class="engine-grid primary-engines">${primary.map(option).join('')}</div>${other.length ? `<details class="engine-expander"><summary>更多引擎 <span>${other.length}</span></summary><div class="engine-grid">${other.map(option).join('')}</div></details>` : ''}<label class="form-label" for="agent-directory">Workspace · 工作目录</label><div class="directory-row"><input class="text-input" id="agent-directory" value="${esc(currentWorkspace()?.directory || '')}" placeholder="C:\\Projects\\my-app"><button data-browse="agent-directory">选择目录</button></div><label class="form-label" for="agent-tag">Tag <span class="optional-label">· 可选</span></label><input class="text-input" id="agent-tag" maxlength="32" placeholder="例如 frontend、review、research"><p class="form-hint">同一种引擎可以启动多个会话。Tag 是分组标签，可用 @tag 提及当前房间中拥有该标签的成员。</p>`, modalButtons('启动 Agent', 'launch-agent'), true);
    $('.modal').classList.add('launcher-modal');
    connections.decorateLaunch(); capabilities.decorateLaunch();
  }
  function showWorkspaceMenu() {
    const menu = $('#workspace-menu');
    menu.hidden = !menu.hidden;
    menu.innerHTML = `${state.workspaces.map(item => `<button class="workspace-option" data-workspace="${esc(item.id)}">${icon('workspace')}<span><strong>${esc(item.title)}</strong><small>${esc(item.directory)}</small></span>${item.id === workspace ? icon('check') : ''}</button>`).join('')}<div class="menu-divider"></div><button class="workspace-new" data-action="new-workspace">${icon('plus')} 添加工作区</button>`;
    if (!menu.hidden) {
      const anchor = (document.activeElement?.closest('[data-action="workspace-menu"]') || $('#workspace-button')).getBoundingClientRect();
      menu.style.left = `${Math.max(10, Math.min(anchor.left, innerWidth - 320))}px`;
      menu.style.top = `${Math.max(48, Math.min(anchor.bottom + 6, innerHeight - menu.offsetHeight - 12))}px`;
    }
  }
  function showNewWorkspace() {
    $('#workspace-menu').hidden = true;
    showModal('添加工作区', '选择本地目录，按目录组织会话和群聊。', `<label class="form-label" for="workspace-title">工作区名称</label><input class="text-input" id="workspace-title" maxlength="40" placeholder="例如：产品实验室"><label class="form-label" for="workspace-directory">本地目录</label><div class="directory-row"><input class="text-input" id="workspace-directory" placeholder="C:\\Projects\\my-app"><button data-browse="workspace-directory">选择目录</button></div>`, modalButtons('添加工作区', 'create-workspace'));
  }
  async function showTerminal(id) {
    const agent = state.agents.find(item => item.id === id);
    if (agent?.mode === 'rpc') return showRpcSession(agent);
    if (state.runtimeMode === 'native') {
      showModal(agent ? `${agent.displayName} 的终端` : '终端', '会话在 Agent Room 内运行。首次信任或登录提示可在这里完成。', '<div id="terminal-status" class="terminal-status">正在连接…</div><div id="native-terminal" style="height:440px;padding:12px;background:#18202c;border-radius:12px"></div>', `<button class="button" id="stop-native-session">停止会话</button><button class="button" data-action="close-modal">关闭面板</button>`, true);
      const element = $('#native-terminal');
      $('#stop-native-session').onclick = () => bridge.stopSession(id).catch(error => toast(error.message));
      const dispose = await window.AgentRoomTerminal.mount({ id, bridge, element, status: $('#terminal-status'), onError: toast });
      if (element.isConnected) terminalDispose = dispose; else dispose();
      return;
    }
    showModal(agent ? `${agent.displayName} 的终端` : '终端', '只读实时画面 · 这里显示原始会话状态，不会向终端注入输入。', `<div id="terminal-status" class="terminal-status">正在读取…</div><pre id="terminal-output" class="terminal-output">连接终端中…</pre>`, '<button class="button" data-action="close-modal">关闭</button>', true);
    const refresh = async () => {
      try {
        const screen = await bridge.terminal(id);
        if (!$('#terminal-output')) return;
        $('#terminal-output').textContent = screen.lines.join('\n');
        $('#terminal-status').textContent = `${screen.ready ? '终端就绪' : '请留意原始终端提示'} · ${new Date().toLocaleTimeString('zh-CN')} 更新`;
      } catch (error) { if ($('#terminal-output')) $('#terminal-output').textContent = error.message; }
    };
    await refresh(); terminalTimer = setInterval(refresh, 3000);
  }
  async function showRpcSession(agent) {
    const id = agent.id;
    showModal(`${agent.displayName} 的会话`, '无终端会话 · 回复直接显示在聊天中。权限请求只在你确认后继续。', '<p id="rpc-status" role="status">正在读取…</p><p id="rpc-error" class="form-hint"></p><div id="rpc-requests"></div>', '<button class="button" id="rpc-cancel">中断当前任务</button><button class="button" id="rpc-stop">停止 Agent</button><button class="button" data-action="close-modal">关闭</button>', true);
    const statusElement = $('#rpc-status');
    const act = async fn => { try { await fn(); await refresh(); } catch (e) { toast(e.message); } };
    $('#rpc-cancel').onclick = () => act(() => bridge.cancelSession(id));
    $('#rpc-stop').onclick = () => act(() => bridge.stopSession(id));
    let requestKey = '';
    async function refresh() {
      const view = await bridge.inspectSession(id);
      if ($('#rpc-status') !== statusElement) return;
      $('#rpc-status').textContent = `${view.alive ? statusLabel(view.status) : '已停止'} · ${view.queueLength || 0} 条排队${view.activity ? ` · ${view.activity.kind}` : ''}`;
      $('#rpc-error').textContent = view.error || '';
      $('#rpc-cancel').disabled = !view.alive || !view.current;
      $('#rpc-stop').disabled = !view.alive;
      const key = JSON.stringify(view.approvals);
      if (key === requestKey) return; requestKey = key;
      $('#rpc-requests').innerHTML = (view.approvals || []).map((r, index) => {
        const d = r.data, questions = d.questions || d.input?.questions || [];
        const fields = r.kind === 'questions' ? questions.map((q, i) => `<label class="form-label" for="rpc-answer-${index}-${i}">${esc(q.question || q.header || q.id)}</label><input class="text-input" id="rpc-answer-${index}-${i}" data-answer-index="${i}" maxlength="4000" placeholder="${esc((q.options || []).map(o => o.label).join(' / '))}">`).join('') : r.kind === 'input' ? `<label class="form-label" for="rpc-value-${index}">${esc(d.title || d.message || '请输入')}</label>${d.method === 'select' ? `<select class="text-input" id="rpc-value-${index}" data-rpc-value>${(d.options || []).map(o => `<option>${esc(o)}</option>`).join('')}</select>` : `<textarea class="text-input" id="rpc-value-${index}" data-rpc-value maxlength="16000"></textarea>`}` : '';
        return `<section class="context-card rpc-request" data-rpc-request="${esc(r.id)}"><strong>${esc(d.title || d.tool_name || d.permission || d.method || '操作确认')}</strong><pre class="rpc-request-detail">${esc(d.command || d.reason || d.message || (r.kind === 'permission' ? JSON.stringify(d.input || d.permissions || d.patterns || d, null, 2) : ''))}</pre>${fields}<div class="modal-actions"><button class="button" data-rpc-decision="deny">${r.kind === 'permission' ? '拒绝' : '取消'}</button><button class="button primary" data-rpc-decision="allow">${r.kind === 'permission' ? '允许本次' : '提交回答'}</button></div></section>`;
      }).join('') || '<p class="form-hint">当前没有待处理的确认。</p>';
      for (const button of document.querySelectorAll('[data-rpc-decision]')) button.onclick = () => act(async () => {
        const card = button.closest('[data-rpc-request]'), allow = button.dataset.rpcDecision === 'allow';
        const answer = { allow, cancelled: !allow, value: card.querySelector('[data-rpc-value]')?.value, answers: [...card.querySelectorAll('[data-answer-index]')].map(input => [input.value]) };
        await bridge.respondSession(id, card.dataset.rpcRequest, answer);
      });
    }
    await refresh(); if (statusElement.isConnected) terminalTimer = setInterval(() => refresh().catch(e => { if (statusElement.isConnected) $('#rpc-error').textContent = e.message; }), 800);
  }
  function showSettings() {
    showModal('连接与设置', 'Agent Room · 本地桌面预览版 0.1.0', `<div class="settings-row"><span>消息连接</span><strong>${state.connection === 'connected' ? 'hcom 已连接' : '连接中断'}</strong></div><div class="settings-row"><span>hcom 版本</span><strong>${esc(state.version || '—')}</strong></div><div class="settings-row"><span>工作区</span><strong>${state.workspaces.length} 个本地目录</strong></div><div class="settings-row"><span>已发现的会话</span><strong>${state.agents.length} 位 Agent</strong></div><button class="button settings-connections" data-action="usage">Token 用量与砖块图 ${icon('layers')}</button><button class="button primary settings-connections" data-action="connections">连接、网关与模型 ${icon('arrow')}</button><button class="button settings-avatars" data-action="avatars">${icon('smile')} Agent 头像<span>随机自动分配 · 优先不重复</span>${icon('arrow')}</button><p class="settings-description">桌面版会话由应用内 Rust 核心托管。关闭窗口时有活跃会话会驻留托盘；退出应用会停止本应用托管的会话。应用按工作目录组织成员，tag 用于筛选与提及，群聊成员可自由组合。</p><p class="settings-description">桌面版内置 hcom 原生核心，无需独立安装或启动 hcom。通过“添加 Agent”创建会话，原有外部 hcom 会话与应用数据互不混用。</p>`, `<button class="button" data-action="source">hcom 开源项目 ${icon('globe')}</button><button class="button primary" data-action="close-modal">知道了</button>`);
  }
  function showAvatars() {
    showModal('每位伙伴，都有自己的模样', '随机遇见，记住彼此。新 Agent 会优先分到尚未使用的头像，分配后自动保存。',
      `<div class="portrait-assigned">${workspaceAgents().map(agent => `<div class="portrait-agent">${avatar(agent, 'large', true)}<strong>${esc(agent.displayName)}</strong><small>${esc(agent.label)} · ${esc(portraits.get(agent)?.name || '')}</small></div>`).join('') || '<p class="empty-state-small">添加 Agent 后会自动分配头像。</p>'}</div><div class="portrait-gallery-heading"><strong>头像伙伴 <span>${window.AgentAvatars.catalog.length}</span></strong><span>8 位原作 · 8 款扩展配色</span></div><div class="portrait-gallery">${window.AgentAvatars.catalog.map(item => `<figure><img src="${item.src}" alt="${item.name}" width="256" height="256"><figcaption>${item.name}</figcaption></figure>`).join('')}</div><p class="form-hint">所有工作区共用头像池，优先避免当前 Agent 重复。超过 ${window.AgentAvatars.catalog.length} 位时均匀复用；刷新、切换工作区和重启都保留已分配的头像。</p>`,
      '<button class="button primary" data-action="close-modal">知道了</button>', true);
  }
  async function modalAction(button, operation) {
    const previous = button.textContent; button.disabled = true; button.textContent = '请稍候…';
    try { await operation(); } catch (error) { toast(error.message); }
    finally { if (button.isConnected) { button.disabled = false; button.textContent = previous; } }
  }
  const connections = window.createConnectionUI({ bridge, getState: () => state, receive, showModal, toast, icon, esc, modalAction });
  window.createUsageUI({ bridge, showModal, icon, esc });
  const capabilities = window.createCapabilityUI({ bridge, getState: () => state, receive, getWorkspace: currentWorkspace, showModal, toast, icon, esc, modalAction });
  document.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (button?.dataset.room) return selectRoom(button.dataset.room);
    if (button?.dataset.workspace) return selectWorkspace(button.dataset.workspace);
    if (button?.dataset.filter) { filter = button.dataset.filter; render(); return; }
    if (button?.dataset.mention !== undefined) return insertMention(Number(button.dataset.mention));
    if (button?.dataset.invite) { insertText(`${input.value && !/\s$/.test(input.value.slice(0, input.selectionStart)) ? ' ' : ''}@${button.dataset.invite} `); return; }
    if (button?.dataset.engine) { document.querySelectorAll('[data-engine]').forEach(item => { item.classList.toggle('selected', item === button); item.setAttribute('aria-pressed', String(item === button)); }); connections.updateLaunch(); capabilities.updateLaunch(); return; }
    if (button?.dataset.window) return bridge.windowAction?.(button.dataset.window);
    if (button?.dataset.terminal) return showTerminal(button.dataset.terminal);
    if (button?.dataset.prompt) { input.value = button.dataset.prompt; input.focus(); updateComposer(); return; }
    if (button?.dataset.expand) { const id = button.dataset.expand; expanded.has(id) ? expanded.delete(id) : expanded.add(id); renderMessages(); return; }
    if (button?.dataset.jump) { document.getElementById(`message-${button.dataset.jump}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); return; }
    if (button?.dataset.copyMessage) { const message = state.messages.find(item => item.id === button.dataset.copyMessage); if (message) { try { await navigator.clipboard.writeText(message.text); toast('消息已复制'); } catch { toast('无法访问剪贴板'); } } return; }
    if (button?.dataset.browse) { const directory = await bridge.chooseDirectory(); if (directory) $(`#${button.dataset.browse}`).value = directory; else if (!bridge.desktop) toast('浏览器预览中请手动填写目录；Electron 版本支持文件夹选择。'); return; }
    const action = button?.dataset.action;
    if (action === 'theme') { theme = theme === 'dark' ? 'light' : 'dark'; storage.set('ar-theme', theme); applyTheme(); return; }
    if (action === 'toggle-sidebar') { sidebarCollapsed = !sidebarCollapsed; storage.set('ar-sidebar-collapsed', sidebarCollapsed); applySidebar(); renderHeader(); return; }
    if (action === 'workspace-menu') return showWorkspaceMenu();
    if (action === 'new-room') return showNewRoom();
    if (action === 'launch') return showLaunch();
    if (action === 'settings') return showSettings();
    if (action === 'avatars') return showAvatars();
    if (action === 'new-workspace') return showNewWorkspace();
    if (action === 'close-modal') return closeModal();
    if (action === 'source') return bridge.openSource();
    if (action === 'members') { details = !details; storage.set('ar-details', details); renderHeader(); renderDetails(); return; }
    if (action === 'conversations') { filter = 'all'; query = ''; $('#search').value = ''; render(); return; }
    if (action === 'search') { $('#search').focus(); return; }
    if (action === 'mention') { insertText(`${input.value && !/\s$/.test(input.value.slice(0, input.selectionStart)) ? ' ' : ''}@`); return; }
    if (action === 'emoji') { insertText(' 🙂 '); return; }
    if (action === 'create-room') return modalAction(button, async () => {
      const result = await bridge.createRoom({ title: $('#room-name').value, members: [...document.querySelectorAll('[name="room-member"]:checked')].map(item => item.value), workspaceId: workspace });
      receive(result.state); closeModal(); selectRoom(result.room.id); toast('新的房间已创建');
    });
    if (action === 'create-workspace') return modalAction(button, async () => {
      const result = await bridge.createWorkspace({ title: $('#workspace-title').value, directory: $('#workspace-directory').value });
      receive(result.state); closeModal(); selectWorkspace(result.workspace.id); toast('工作区已添加');
    });
    if (action === 'launch-agent') return modalAction(button, async () => {
      const tool = document.querySelector('[data-engine].selected')?.dataset.engine;
      const result = await bridge.launch({ tool, directory: $('#agent-directory').value, tag: $('#agent-tag').value, ...connections.launchPayload(), ...capabilities.launchPayload() });
      receive(result.state); closeModal();
      toast(result.result.handles?.[0]?.mode === 'rpc' ? 'Agent 已就绪，可以直接 @ 它聊天。' : 'Agent 已启动，请查看会话状态。');
    });
    if (event.target.classList.contains('modal-backdrop')) closeModal();
    if (!event.target.closest('#workspace-menu') && !event.target.closest('#workspace-button')) $('#workspace-menu').hidden = true;
  });
  input.addEventListener('input', () => { mentionIndex = 0; drafts[active] = input.value; updateComposer(); renderMentions(); });
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (!$('#mention-menu').hidden) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); mentionIndex = (mentionIndex + (event.key === 'ArrowDown' ? 1 : -1) + mentionItems.length) % mentionItems.length; renderMentions(); return; }
      if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); insertMention(mentionIndex); return; }
      if (event.key === 'Escape') { $('#mention-menu').hidden = true; event.stopPropagation(); return; }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); send(); }
  });
  document.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && !document.querySelector('.modal')) {
      const key = event.key.toLowerCase();
      if (key === 'k') { event.preventDefault(); sidebarCollapsed = false; applySidebar(); renderHeader(); $('#search').focus(); }
      if (key === 'b') { event.preventDefault(); sidebarCollapsed = !sidebarCollapsed; storage.set('ar-sidebar-collapsed', sidebarCollapsed); applySidebar(); renderHeader(); }
      if (key === 'n') { event.preventDefault(); showNewRoom(); }
    }
    if (event.key === 'Escape') { closeModal(); $('#mention-menu').hidden = true; $('#workspace-menu').hidden = true; }
    // Keep keyboard focus inside an open dialog.
    const modal = document.querySelector('.modal');
    if (modal && event.key === 'Tab') {
      const items = [...modal.querySelectorAll('button:not(:disabled),input,textarea,select,summary')];
      const first = items[0], last = items.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  });
  $('#search').addEventListener('input', event => { query = event.target.value; renderSidebar(); });
  $('#workspace-button').addEventListener('click', showWorkspaceMenu);
  $('#send-button').addEventListener('click', send);
  $('#refresh-button').addEventListener('click', async () => { try { receive(await bridge.refresh()); toast('会话列表已刷新'); } catch (error) { toast(error.message); } });
  bridge.onState(receive);
  bridge.getState().then(receive).catch(error => toast(error.message));
})();
