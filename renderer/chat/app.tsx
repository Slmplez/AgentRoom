import React, { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Agent, ChatClient, PlatformClient, Snapshot } from './types';
import { QuestionInteraction, type QuestionDraft } from './questions';
import { Composer, type Draft } from './composer';
import { ChatThread, DiffPreview } from './thread';
import { MemberActions } from './members';
import { MemorySettings } from './memory-panel';
import { LocalTasks } from './local-tasks';
import { Consultations, type ConsultationRequest } from './consultations';
import { RunPanel } from './runs';
import { ApprovalCenter } from './approvals';
import type { createMockTransport } from '../client/mock.mjs';
import './chat.css';
import './interaction.css';
import './sidebar.css';
import { SettingsPanel, type SettingsSection } from './settings-panel';
import { useResultSplit } from './split-pane';
import type { ArtifactSelection } from './artifact-view';
import InlineArtifact from './inline-artifact';
import './artifact-view.css';
import './diff-preview.css';

const ResultPanel = lazy(() => import('./results'));
const ArtifactView = lazy(() => import('./artifact-view'));
const previewText = (text: string) => text.replace(/```[\s\S]*?```/g, ' [代码] ').replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片]').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[#*`>|_]/g, '').replace(/\s+/g, ' ').trim();

type Control = ReturnType<typeof createMockTransport>['control'];
function readLocal(key: string, fallback: unknown) { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } }
function saveLocal(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* A storage quota must not prevent chatting. */ } }
export function Icon({ name }: { name: string }) { return <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: window.icon(name) }} />; }
export function App({ client, platform, control, persistent = false }: { client: ChatClient; platform: PlatformClient; control?: Control; persistent?: boolean }) {
  const state = useSyncExternalStore(client.subscribe, client.read), mock = Boolean(control);
  const prefix = useMemo(() => persistent ? `ar-persistent-${client.read().databaseId}-` : mock ? 'ar-chat-mock-' : 'ar-chat-', [client, mock, persistent]);
  const [theme, setTheme] = useState<string>(() => readLocal(`${prefix}theme`, readLocal('ar-theme', 'light')) as string);
  const [active, setActive] = useState(''), [workspace, setWorkspace] = useState(''), [query, setQuery] = useState('');
  const [sidebar, setSidebar] = useState(true), [details, setDetails] = useState(false), [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => readLocal(`${prefix}drafts`, {}) as Record<string, Draft>);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, QuestionDraft>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [settings, setSettings] = useState<SettingsSection | null>(null), [requestedApproval, setRequestedApproval] = useState<string | null>(null);
  const [memberRoomId, setMemberRoomId] = useState('');
  const [consultRequest, setConsultRequest] = useState<ConsultationRequest | null>(null);
  const diffTrigger = useRef<HTMLElement | null>(null);
  const [diff, setDiff] = useState<string[] | null>(null);
  const [resultsOpen, setResultsOpen] = useState(false), [resultsLoaded, setResultsLoaded] = useState(false);
  const [artifact, setArtifact] = useState<ArtifactSelection | null>(null);
  const closeArtifact = () => setArtifact(null);
  const resultSplit = useResultSplit(resultsOpen || Boolean(artifact) || Boolean(diff), () => { setResultsOpen(false); closeArtifact(); setDiff(null); }, `${prefix}result-width`);
  const avatarStore = useMemo(() => window.AgentAvatars.create({ saved: readLocal(mock ? 'ar-mock-agent-avatars' : 'ar-agent-avatars', {}) }), [mock]);
  useEffect(() => { if (!persistent || client.read().connection !== 'live') void client.open(); return () => client.close(); }, [client, persistent]);
  useEffect(() => { document.documentElement.dataset.theme = theme; saveLocal(`${prefix}theme`, theme); }, [theme, prefix]);
  useEffect(() => { saveLocal(`${prefix}drafts`, drafts); }, [drafts, prefix]);
  if (avatarStore.sync(state.agents)) saveLocal(mock ? 'ar-mock-agent-avatars' : 'ar-agent-avatars', avatarStore.export());
  useEffect(() => { setQuestionDrafts(old => Object.fromEntries(Object.entries(old).filter(([key]) => state.currentUserId && state.questions.some(q => (q.canAnswer || q.status === 'expired') && key === `${state.instanceId}:${state.currentUserId}:${q.roomId}:${q.id}`)))); }, [state.instanceId, state.currentUserId, state.questions]);
  const portrait = (agent: Agent) => avatarStore.get(agent)?.src || '';
  const currentWorkspace = state.workspaces.find(w => w.id === workspace) || state.workspaces[0];
  const rooms = state.rooms.filter(r => r.workspaceId === currentWorkspace?.id);
  const search = query.trim().toLowerCase();
  const visibleRooms = rooms.filter(r => r.title.toLowerCase().includes(search) || state.agents.some(a => r.memberIds.includes(a.id) && `${a.name} ${a.displayName}`.toLowerCase().includes(search)));
  const room = rooms.find(r => r.id === active) || rooms[0];
  const members = state.agents.filter(a => room?.memberIds.includes(a.id));
  const messages = useMemo(() => state.messages.filter(m => m.roomId === room?.id), [state.messages, room?.id]);
  const connectionLabel = ({ live: mock ? '演示模式' : '已连接', connecting: '正在连接…', resyncing: '正在同步…', offline: '连接已断开' } as Record<string, string>)[state.connection];
  useEffect(() => { setArtifact(old => old?.roomId === room?.id ? old : null); }, [room?.id]);
  useEffect(() => { setArtifact(null); }, [state.databaseId]);
  useEffect(() => { setDiff(null); }, [room?.id, state.databaseId]);
  const selectRoom = (id: string) => { setArtifact(null); setActive(id); setError(''); if (window.innerWidth < 760) { setSidebar(false); setResultsOpen(false); } };
  const showResults = () => { setDiff(null); setArtifact(null); setDetails(false); setResultsLoaded(true); setResultsOpen(true); if (window.innerWidth < 760) setSidebar(false); };
  const openSettings = (section: SettingsSection) => { document.querySelectorAll<HTMLDetailsElement>('.sidebar-create, .dev-controls').forEach(menu => { if (menu.open) menu.querySelector('summary')?.focus(); menu.open = false; }); setSettings(section); };
  return <div className={`chat-app ${sidebar ? '' : 'chat-sidebar-closed'}`}>
    <header className="titlebar"><div className="brand"><Icon name="room-mark" /><span className="brand-name">Agent Room</span></div>
      <div className="titlebar-right">{control && <details className="dev-controls" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }} onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}><summary>模拟场景</summary><div><button onClick={() => { control.reset(); setDrafts({}); setError(''); }}>重置场景</button><button onClick={() => control.reset(true)}>空对话</button><button onClick={() => control.reset("empty-workspace")}>空工作区</button><button onClick={() => control.pause()}>暂停场景</button><button onClick={() => control.resume()}>继续场景</button><button onClick={() => control.adviceResults()}>推进建议答复</button><button onClick={() => control.adviceResults('failed')}>建议失败</button><button onClick={() => control.adviceResults('unknown')}>建议未知</button><button onClick={() => control.adviceResults('late')}>晚到旧建议</button><button onClick={() => control.adviceMemberLeft()}>建议成员离开</button><button onClick={() => control.question(room?.id)}>协作问题</button><button onClick={() => control.question(room?.id, true)}>多选问题</button><button onClick={() => control.questionFailure('reject')}>答复失败</button><button onClick={() => control.questionFailure('unknown')}>答复未知</button><button onClick={() => control.questionChange('revision')}>更新问题</button><button onClick={() => control.questionChange('expired')}>问题过期</button><button onClick={() => control.questionChange('revoke')}>撤销问题</button><button onClick={() => control.questionChange('other')}>他人已答复</button><button onClick={() => control.artifact(room?.id)}>发布模拟报告</button><button onClick={() => control.tools(room?.id)}>工具与差异</button><button onClick={() => control.longTools(room?.id)}>长输出</button><button onClick={() => control.largeDiff(room?.id)}>大差异</button><button onClick={() => control.failedTools(room?.id)}>工具失败</button><button onClick={() => control.invalidDiff(room?.id)}>无效差异</button><button onClick={() => control.expireTools()}>输出过期</button><button onClick={() => control.approval('permission', room?.id)}>权限确认</button><button onClick={() => control.approval('questions', room?.id)}>用户提问</button><button onClick={() => control.expire()}>使请求失效</button><button onClick={() => control.disconnect()}>模拟断线</button><button onClick={() => control.reconnect()}>恢复连接</button><button onClick={() => control.history(room?.id)}>长对话</button><button onClick={() => control.advance()}>推进流式输出</button><p>确定性模拟数据，不连接模型、不执行本机操作。</p></div></details>}<span className={`local-badge ${mock ? 'mock-badge' : ''}`}>{mock ? '模拟开发' : persistent ? state.capabilities.localExecution ? '本机只读 Agent' : '持久讨论' : '本地联调'}</span><button className="theme-toggle" aria-label="切换主题" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
        {platform.desktop && <div className="window-controls">{['minimize', 'maximize', 'close'].map((action, i) => <button key={action} aria-label={['最小化', '最大化', '关闭窗口'][i]} onClick={() => platform.windowAction(action)}><Icon name={['minus', 'square', 'close'][i]} /></button>)}</div>}
      </div>
    </header>
    <div className="app-layout" ref={resultSplit.host} style={resultSplit.style} data-result-layout={resultSplit.layout} data-pane-dragging={resultSplit.dragging || undefined}>
      <aside className="sidebar" aria-label="会话列表" inert={!sidebar}>
        <div className="chat-workspace"><Icon name="workspace" /><select aria-label="工作区" value={currentWorkspace?.id || ''} onChange={e => { if (e.target.value === '__manage') { openSettings('workspaces'); return; } setWorkspace(e.target.value); setActive(''); setQuery(''); }}>{!state.workspaces.length && <option value="">选择工作区</option>}{state.workspaces.map(w => <option key={w.id} value={w.id}>{w.title}</option>)}{!persistent && <option value="__manage">管理工作区…</option>}</select><button className="icon-button" aria-label="收起侧栏" onClick={() => setSidebar(false)}><Icon name="panel-left" /></button></div>
        <div className="sidebar-top"><strong className="chat-sidebar-title">对话</strong>{!persistent && <details className="sidebar-create" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.open = false; }} onKeyDown={e => { if (e.key === 'Escape') { e.currentTarget.open = false; e.currentTarget.querySelector('summary')?.focus(); } }}><summary aria-label="创建会话" title="创建会话"><Icon name="plus" /></summary><div><button onClick={() => openSettings('launch')}>添加 Agent</button><button onClick={() => openSettings('new-room')}>新建群聊</button></div></details>}</div>
        <label className="search-box"><Icon name="search" /><input placeholder="搜索会话或成员" aria-label="搜索会话" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <div className="conversation-list">{(persistent ? ['group'] as const : ['group', 'dm'] as const).map(type => <React.Fragment key={type}><div className="section-label">{type === 'group' ? '群聊' : '单个 Agent'}</div>{visibleRooms.filter(r => r.type === type).map(r => {
          const agent = state.agents.find(a => a.id === r.memberIds[0]); const last = state.messages.filter(m => m.roomId === r.id).at(-1);
          return <button className={`conversation-item ${room?.id === r.id ? 'selected' : ''}`} key={r.id} data-room={r.id} aria-current={room?.id === r.id ? 'page' : undefined} onClick={() => selectRoom(r.id)}>
            {type === 'dm' && agent ? <span className="avatar character"><img src={portrait(agent)} alt="" /></span> : <span className="group-icon"><Icon name="chats" /></span>}
            <span className="conversation-content"><span className="conversation-title">{r.title}</span><span className="conversation-preview">{last?.text ? previewText(last.text) : (type === 'dm' ? agent?.engine : `${r.memberIds.length} 位成员`)}</span></span>
          </button>;
        })}</React.Fragment>)}{!rooms.length && <p className="list-empty">{state.connection === 'live' ? '当前没有会话' : '正在等待工作区…'}</p>}{rooms.length > 0 && !visibleRooms.length && <div className="chat-search-empty" role="status"><p>没有匹配的会话或成员</p><button className="button" onClick={() => setQuery('')}>清除搜索</button></div>}</div>
        <div className="sidebar-footer"><div className={`connection-line ${state.connection === 'offline' ? 'offline' : ''} ${mock ? 'is-demo' : ''}`}><span className="connection-dot" /><span id="connection-text" role="status">{connectionLabel}</span>{state.connection !== 'live' && <button className="icon-button" aria-label="重新连接" disabled={state.connection === 'connecting' || state.connection === 'resyncing'} onClick={() => void client.open()}><Icon name="refresh" /></button>}</div>
          <button className="icon-button sidebar-settings-button" aria-label="设置" title="设置" onClick={() => openSettings('connections')}><Icon name="settings" /></button>
        </div>
      </aside>
      <main className="conversation">
        <header className="conversation-header"><div className="header-location"><button className="icon-button" aria-label="切换侧栏" aria-expanded={sidebar} onClick={() => setSidebar(!sidebar)}><Icon name="panel-left" /></button>{room?.type === 'dm' && members[0] && <span className="avatar character small"><img src={portrait(members[0])} alt="" /></span>}<div><h1 className="header-title">{room?.title || 'Agent Room'}</h1><div className="room-subtitle">{room?.type === 'dm' ? `${members[0]?.engine || 'Agent'} · 独立对话` : `${persistent ? room?.memberIds.length || 0 : members.length} 位成员`}</div></div></div><div className="header-actions">{mock && <button className="button result-open-button" aria-expanded={resultsOpen} onClick={showResults}>结果示例</button>}{!persistent && <button className="icon-button" aria-label="查看成员" aria-expanded={details} onClick={() => { setDiff(null); setArtifact(null); setResultsOpen(false); setDetails(!details); }}><Icon name="panel-left" /></button>}</div></header>
        {state.connection !== 'live' && <div className="connection-alert" role="status">{state.error || connectionLabel}</div>}
        {persistent && state.syncNotice && <p className="connection-alert" role="status">{state.syncNotice}</p>}
        {persistent && state.beforeSequence != null && <button className="button" data-load-history disabled={state.historyLoading || state.connection !== 'live'} onClick={() => void client.loadOlderMessages?.().catch(e => setError(e.message))}>{state.historyLoading ? '正在加载历史…' : '加载更早的消息'}</button>}
        {persistent && room && <LocalTasks key={`local:${state.backendId}:${state.databaseId}:${state.currentUserId}:${room.id}`} client={client} state={state} roomId={room.id} onConsult={task => setConsultRequest({ taskId:task.id,questionId:task.question!.id,questionRevision:task.question!.revision,nonce:crypto.randomUUID() })} />}
        {persistent && room && <Consultations key={`consultations:${state.backendId}:${state.databaseId}:${state.currentUserId}:${room.id}`} client={client} state={state} roomId={room.id} request={consultRequest} />}
        <RunPanel client={client} state={state} roomId={room?.id} />
        <ChatThread client={client} renderArtifacts={message => state.capabilities.readOnlyArtifacts && message.artifactRefs.length > 0 ? <div className="artifact-links" aria-label="交付报告">{message.artifactRefs.map(ref => {
          const selection = { ...ref, roomId: message.roomId, messageId: message.id };
          const open = () => { setDiff(null); setResultsOpen(false); setDetails(false); setArtifact(selection); if (window.innerWidth < 760) setSidebar(false); };
          return <InlineArtifact key={JSON.stringify([state.backendId, state.databaseId || state.instanceId, state.currentUserId, message.roomId, ref.artifactId, ref.version])} client={client} selection={selection} mock={mock} open={open} />;
        })}</div> : null} suppressWelcome={persistent && (state.localTasks.length > 0 || state.consultations.length > 0)} renderQuestions={messageId => state.capabilities.collaborationQuestions && state.currentUserId ? state.questions.filter(q => q.sourceMessageId === messageId && q.roomId === room?.id).map(q => {
          const key = `${state.instanceId}:${state.currentUserId}:${q.roomId}:${q.id}`;
          const draft = questionDrafts[key] || { revision: q.revision, optionIds: [], text: '' };
          return <QuestionInteraction key={key} client={client} question={q} members={members} adviceEnabled={state.capabilities.questionAdvice} userId={state.currentUserId!} draft={draft} update={value => { const latest = client.read(); if (latest.instanceId === state.instanceId && latest.currentUserId === state.currentUserId && latest.questions.some(item => item.id === q.id && (item.canAnswer || item.status === 'expired'))) setQuestionDrafts(old => ({ ...old, [key]: value })); }} />;
        }) : null} group={room?.type === 'group'} statusMessageIds={state.runs.filter(r => r.roomId === room?.id && r.status !== 'complete').flatMap(r => r.messageId ? [r.messageId] : [])} key={`thread:${room?.id || 'empty'}`} messages={messages} agents={state.agents} portrait={portrait} showDiff={(patches, trigger) => { diffTrigger.current = trigger || null; setArtifact(null); setResultsOpen(false); setDetails(false); setDiff(patches); if (window.innerWidth < 760) setSidebar(false); }} expanded={expanded} onExpanded={(id, value) => setExpanded(old => old[id] === value ? old : { ...old, [id]: value })} />
        {error && <div className="chat-error" role="alert">{error}<button aria-label="关闭提示" onClick={() => setError('')}>×</button></div>}
        {room && <Composer key={`composer:${state.databaseId || state.instanceId}:${room.id}`} client={client} room={room} agents={members} portrait={portrait} openMembers={() => { setDiff(null); setArtifact(null); setResultsOpen(false); setDetails(!details); }} membersOpen={details} draft={drafts[room.id] || { text: '', mentions: [] }} updateDraft={draft => setDrafts(old => ({ ...old, [room.id]: draft }))} live={state.connection === 'live'} tasks={state.capabilities.tasks} mock={mock} persistent={persistent} pendingOperations={state.pendingOperations?.filter(o => !o.type || o.type === 'send')} onError={setError} />}
      </main>
      {resultSplit.separator}
      {diff && <DiffPreview returnFocus={diffTrigger.current} patches={diff} close={() => setDiff(null)} theme={theme} />}
      {artifact && artifact.roomId === room?.id && <Suspense fallback={<aside className="result-panel" role="status">正在打开报告…<button className="button" onClick={closeArtifact}>返回对话</button></aside>}><ArtifactView key={`${state.databaseId || state.instanceId}:${artifact.roomId}:${artifact.artifactId}:${artifact.version}:${artifact.messageId}`} client={client} selection={artifact} latestVersion={Math.max(artifact.version, ...messages.flatMap(m => m.artifactRefs.filter(ref => ref.artifactId === artifact.artifactId).map(ref => ref.version)))} mock={mock} close={closeArtifact} /></Suspense>}
      {details && <aside className="details-panel" aria-label="工作区与成员"><div className="details-title">工作区与成员<button className="icon-button" aria-label="关闭成员面板" onClick={() => setDetails(false)}><Icon name="close" /></button></div><section className="context-card"><strong>{currentWorkspace?.title}</strong><p className="detail-note">{currentWorkspace?.directory}</p></section><div className="details-section-title member-section-heading"><span>{room?.type === 'dm' ? '当前 Agent' : '房间成员'}<span className="member-count">{members.length}</span></span>{!persistent && room?.type === 'group' && !room.pinned && <button className="member-manage" onClick={() => { setMemberRoomId(room.id); openSettings('members'); }}>管理成员</button>}</div>{members.map(a => <MemberActions key={a.id} agent={a} client={client} live={state.connection === 'live'}><button className="member-card" title={`与 ${a.displayName} 私聊`} onClick={() => { const direct = state.rooms.find(r => r.type === 'dm' && r.memberIds.includes(a.id)); if (direct) selectRoom(direct.id); setDetails(false); }}><span className="avatar character small"><img src={portrait(a)} alt="" /></span><span><strong>{a.displayName}</strong><small>{a.engine}{a.status === 'inactive' && ' · 已停止'}</small></span><span className="member-direct" aria-hidden="true">↗</span></button></MemberActions>)}{persistent && <p className="detail-note">当前为本机单用户讨论。</p>}</aside>}
      {mock && resultsLoaded && <Suspense fallback={resultsOpen ? <aside className="result-panel" role="status">正在打开结果预览…</aside> : null}><ResultPanel roomId={room?.id || 'empty'} roomTitle={room?.title || '当前会话'} open={resultsOpen} close={() => setResultsOpen(false)} /></Suspense>}
    </div>

    {persistent ? (settings && <PersistentSettings client={client} state={state} roomId={room?.id} close={() => setSettings(null)} />) : <SettingsPanel client={client} platform={platform} state={state} memberRoomId={memberRoomId} editMembers={id => { setMemberRoomId(id); openSettings('members'); }} section={settings} select={setSettings} close={() => setSettings(null)} workspaceId={currentWorkspace?.id || ''} selectWorkspace={id => { setWorkspace(id); setActive(''); setQuery(''); }} mock={mock} created={(kind, id) => { if (id) { const target = kind === 'new-room' ? id : client.read().rooms.find(r => r.type === 'dm' && r.memberIds.includes(id))?.id; if (target) selectRoom(target); } setSettings(null); }} openRequest={id => { setSettings(null); setRequestedApproval(id); }} />}
    <ApprovalCenter client={client} state={state} activeRoomId={room?.id} requestedId={requestedApproval} requestHandled={() => setRequestedApproval(null)} />
  </div>;
}

function PersistentSettings({ client, state, roomId, close }: { client: ChatClient; state: Snapshot; roomId?: string; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null), [section, setSection] = useState<'general' | 'memory'>('general');
  const memoryAvailable = Boolean(state.capabilities.agentMemory && roomId);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.showModal(); dialog.current?.querySelector<HTMLElement>('h2')?.focus(); return () => { dialog.current?.close(); previous?.isConnected && previous.focus(); }; }, []);
  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="persistent-title" onCancel={e => { e.preventDefault(); close(); }}>
    <header className="settings-heading"><h2 id="persistent-title" tabIndex={-1}>设置</h2><button className="icon-button" aria-label="关闭设置" onClick={close}>×</button></header>
    <div className="settings-layout"><nav aria-label="设置分类">
      <button aria-current={section === 'general' ? 'page' : undefined} onClick={() => setSection('general')}>通用</button>
      {memoryAvailable && <button aria-current={section === 'memory' ? 'page' : undefined} onClick={() => setSection('memory')}>记忆</button>}
    </nav><div className="settings-body" key={section}>
      {section === 'memory' && memoryAvailable ? <MemorySettings key={JSON.stringify([state.backendId, state.databaseId, state.currentUserId, roomId])} client={client} state={state} roomId={roomId!} /> : <>
        <h3>持久讨论</h3><p>{state.capabilities.localExecution ? '桌面和浏览器共用本机持久消息与只读 Pi 任务。已启用原生问题答复；工具审批、多人登录和 Teams 尚未开放。' : '桌面和浏览器共用本机持久消息。当前模式不提供 Agent 执行、工具审批、多人登录或 Teams。'}</p><p>关闭窗口只断开当前界面；停止服务请在启动服务的终端按 Ctrl+C。后端启动信息中显示独立数据目录。</p>
        <dl><dt>数据库标识</dt><dd>{state.databaseId}</dd><dt>当前后端实例</dt><dd>{state.instanceId}</dd></dl><p>首次启动创建一间持久讨论房间。历史可分页读取；已过期的事件通知不会逐条重放。</p>
      </>}
    </div></div>
  </dialog>;
}
