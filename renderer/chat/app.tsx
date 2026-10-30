import React, { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { Agent, ChatClient, PlatformClient } from './types';
import { Composer, type Draft } from './composer';
import { ChatThread, DiffDialog } from './thread';
import { ApprovalCenter } from './approvals';
import type { createMockTransport } from '../client/mock.mjs';
import './chat.css';

type Control = ReturnType<typeof createMockTransport>['control'];
function readLocal(key: string, fallback: unknown) { try { return JSON.parse(localStorage.getItem(key) || 'null') ?? fallback; } catch { return fallback; } }
function saveLocal(key: string, value: unknown) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* A storage quota must not prevent chatting. */ } }
export function Icon({ name }: { name: string }) { return <span aria-hidden="true" dangerouslySetInnerHTML={{ __html: window.icon(name) }} />; }
export function App({ client, platform, control }: { client: ChatClient; platform: PlatformClient; control?: Control }) {
  const state = useSyncExternalStore(client.subscribe, client.read), mock = Boolean(control), prefix = mock ? 'ar-chat-mock-' : 'ar-chat-';
  const [theme, setTheme] = useState<string>(() => readLocal(`${prefix}theme`, readLocal('ar-theme', 'light')) as string);
  const [active, setActive] = useState(''), [workspace, setWorkspace] = useState(''), [query, setQuery] = useState('');
  const [sidebar, setSidebar] = useState(true), [details, setDetails] = useState(false), [error, setError] = useState('');
  const [drafts, setDrafts] = useState<Record<string, Draft>>(() => readLocal(`${prefix}drafts`, {}) as Record<string, Draft>);
  const [diff, setDiff] = useState<string[] | null>(null);
  const avatarStore = useMemo(() => window.AgentAvatars.create({ saved: readLocal(mock ? 'ar-mock-agent-avatars' : 'ar-agent-avatars', {}) }), [mock]);
  useEffect(() => { void client.open(); return () => client.close(); }, [client]);
  useEffect(() => { document.documentElement.dataset.theme = theme; saveLocal(`${prefix}theme`, theme); }, [theme, prefix]);
  useEffect(() => { saveLocal(`${prefix}drafts`, drafts); }, [drafts, prefix]);
  if (avatarStore.sync(state.agents)) saveLocal(mock ? 'ar-mock-agent-avatars' : 'ar-agent-avatars', avatarStore.export());
  const portrait = (agent: Agent) => avatarStore.get(agent)?.src || '';
  const currentWorkspace = state.workspaces.find(w => w.id === workspace) || state.workspaces[0];
  const rooms = state.rooms.filter(r => r.workspaceId === currentWorkspace?.id);
  const room = rooms.find(r => r.id === active) || rooms[0];
  const members = state.agents.filter(a => room?.memberIds.includes(a.id));
  const messages = useMemo(() => state.messages.filter(m => m.roomId === room?.id), [state.messages, room?.id]);
  const connectionLabel = ({ live: mock ? '模拟连接正常' : '已连接', connecting: '正在连接…', resyncing: '正在同步…', offline: '连接已断开' } as Record<string, string>)[state.connection];
  const selectRoom = (id: string) => { setActive(id); setError(''); if (window.innerWidth < 760) setSidebar(false); };
  return <div className={`chat-app ${sidebar ? '' : 'chat-sidebar-closed'}`}>
    <header className="titlebar"><div className="brand"><Icon name="room-mark" /><span className="brand-name">Agent Room</span></div>
      <div className="titlebar-right"><span className={`local-badge ${mock ? 'mock-badge' : ''}`}>{mock ? '模拟开发' : '本地联调'}</span><button className="theme-toggle" aria-label="切换主题" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}><Icon name={theme === 'dark' ? 'sun' : 'moon'} /></button>
        {platform.desktop && <div className="window-controls">{['minimize', 'maximize', 'close'].map((action, i) => <button key={action} aria-label={['最小化', '最大化', '关闭窗口'][i]} onClick={() => platform.windowAction(action)}><Icon name={['minus', 'square', 'close'][i]} /></button>)}</div>}
      </div>
    </header>
    <div className="app-layout">
      <aside className="sidebar" aria-label="会话列表" inert={!sidebar}>
        <div className="sidebar-top"><strong className="chat-sidebar-title">对话</strong><button className="icon-button" aria-label="收起侧栏" onClick={() => setSidebar(false)}><Icon name="panel-left" /></button></div>
        <label className="search-box"><Icon name="search" /><input placeholder="搜索会话或成员" aria-label="搜索会话" value={query} onChange={e => setQuery(e.target.value)} /></label>
        <div className="chat-workspace"><Icon name="workspace" /><select aria-label="工作区" value={currentWorkspace?.id || ''} onChange={e => { setWorkspace(e.target.value); setActive(''); setQuery(''); }}>{state.workspaces.map(w => <option key={w.id} value={w.id}>{w.title}</option>)}</select></div>
        <div className="conversation-list">{(['group', 'dm'] as const).map(type => <React.Fragment key={type}><div className="section-label">{type === 'group' ? '群聊' : '单个 Agent'}</div>{rooms.filter(r => r.type === type && r.title.toLowerCase().includes(query.toLowerCase())).map(r => {
          const agent = state.agents.find(a => a.id === r.memberIds[0]); const last = state.messages.filter(m => m.roomId === r.id).at(-1);
          return <button className={`conversation-item ${room?.id === r.id ? 'selected' : ''}`} key={r.id} data-room={r.id} aria-current={room?.id === r.id ? 'page' : undefined} onClick={() => selectRoom(r.id)}>
            {type === 'dm' && agent ? <span className="avatar character"><img src={portrait(agent)} alt="" /></span> : <span className="group-icon"><Icon name="chats" /></span>}
            <span className="conversation-content"><span className="conversation-title">{r.title}</span><span className="conversation-preview">{last?.text || (type === 'dm' ? agent?.engine : `${r.memberIds.length} 位成员`)}</span></span>
          </button>;
        })}</React.Fragment>)}{!rooms.length && <p className="list-empty">{state.connection === 'live' ? '当前没有会话' : '正在等待工作区…'}</p>}</div>
        <div className="sidebar-footer"><div className={`connection-line ${state.connection === 'offline' ? 'offline' : ''}`}><span className="connection-dot" /><span id="connection-text" role="status">{connectionLabel}</span><button className="icon-button" aria-label="重新连接" onClick={() => void client.open()}><Icon name="refresh" /></button></div>
          {!mock && <a className="chat-legacy-link" href="index.html">打开现有工作台与设置 ↗</a>}
        </div>
      </aside>
      <main className="conversation">
        <header className="conversation-header"><div className="header-location"><button className="icon-button" aria-label="切换侧栏" onClick={() => setSidebar(!sidebar)}><Icon name="panel-left" /></button><div><h1 className="header-title">{room?.title || 'Agent Room'}</h1><div className="room-subtitle">{room?.type === 'dm' ? members[0]?.engine : `${members.length} 位成员`}</div></div></div><button className="icon-button" aria-label="查看成员" aria-expanded={details} onClick={() => setDetails(!details)}><Icon name="agents" /></button></header>
        {state.connection !== 'live' && <div className="connection-alert" role="status">{state.error || connectionLabel}</div>}
        <ChatThread key={`thread:${room?.id || 'empty'}`} messages={messages} agents={state.agents} portrait={portrait} showDiff={setDiff} />
        {error && <div className="chat-error" role="alert">{error}<button aria-label="关闭提示" onClick={() => setError('')}>×</button></div>}
        {room && <Composer key={`composer:${room.id}`} client={client} room={room} agents={members} draft={drafts[room.id] || { text: '', mentions: [] }} updateDraft={draft => setDrafts(old => ({ ...old, [room.id]: draft }))} live={state.connection === 'live'} tasks={state.capabilities.tasks} mock={mock} onError={setError} />}
      </main>
      {details && <aside className="details-panel" aria-label="工作区与成员"><div className="details-title">工作区与成员<button className="icon-button" aria-label="关闭成员面板" onClick={() => setDetails(false)}><Icon name="close" /></button></div><section className="context-card"><strong>{currentWorkspace?.title}</strong><p className="detail-note">{currentWorkspace?.directory}</p></section><div className="details-section-title">{room?.type === 'dm' ? '当前 Agent' : '房间成员'}</div>{members.map(a => <button className="member-card" key={a.id} onClick={() => { selectRoom(`dm:${a.id}`); setDetails(false); }}><span className="avatar character small"><img src={portrait(a)} alt="" /></span><span><strong>{a.displayName}</strong><small>{a.engine}</small></span><span>↗</span></button>)}</aside>}
    </div>
    {control && <details className="dev-controls"><summary>模拟场景</summary><div><button onClick={() => { control.reset(); setDrafts({}); setError(''); }}>重置场景</button><button onClick={() => control.reset(true)}>空对话</button><button onClick={() => control.reset("empty-workspace")}>空工作区</button><button onClick={() => control.pause()}>暂停场景</button><button onClick={() => control.resume()}>继续场景</button><button onClick={() => control.tools(room?.id)}>工具与差异</button><button onClick={() => control.approval('permission', room?.id)}>权限确认</button><button onClick={() => control.approval('questions', room?.id)}>用户提问</button><button onClick={() => control.expire()}>使请求失效</button><button onClick={() => control.disconnect()}>模拟断线</button><button onClick={() => control.reconnect()}>恢复连接</button><button onClick={() => control.history(room?.id)}>长对话</button><button onClick={() => control.advance()}>推进流式输出</button></div><p>确定性模拟数据，不连接模型、不执行本机操作。</p></details>}
    <ApprovalCenter client={client} state={state} />
    {diff && <DiffDialog patches={diff} close={() => setDiff(null)} theme={theme} />}
  </div>;
}
