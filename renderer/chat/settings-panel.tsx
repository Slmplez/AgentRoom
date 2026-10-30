import React, { useEffect, useRef, useState } from 'react';
import type { ChatClient, Snapshot } from './types';
import { ConnectionSettings } from './connection-settings';
import { CapabilitySettings, CreationSettings, UsageSettings, WorkspaceSettings } from './management-settings';
import { useSettingsActions } from './settings-data';
import { useEntrance } from './motion';

export type SettingsSection = 'connections' | 'capabilities' | 'permissions' | 'workspaces' | 'usage' | 'launch' | 'new-room';
const sections = { connections: '连接与模型', capabilities: '工具与技能', permissions: '权限', workspaces: '工作区', usage: '用量', launch: '添加 Agent', 'new-room': '新建群聊' };
export function SettingsPanel({ client, state, section, select, close, workspaceId, selectWorkspace, created, openRequest, mock }: {
  client: ChatClient; state: Snapshot; section: SettingsSection | null; select(section: SettingsSection): void; close(): void;
  workspaceId: string; selectWorkspace(id: string): void; created(kind: 'launch' | 'new-room', id?: string): void; openRequest(id: string): void; mock: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null), actions = useSettingsActions(client, state.connection === 'live');
  const [visited, setVisited] = useState<SettingsSection[]>([]), title = section ? sections[section] : '设置';
  useEffect(() => { if (section) setVisited(old => old.includes(section) ? old : [...old, section]); }, [section]);
  useEffect(() => { dialog.current?.querySelector('.settings-body')?.scrollTo(0, 0); }, [section]);
  const open = Boolean(section);
  useEffect(() => {
    const node = dialog.current;
    if (!open) { node?.close(); return; }
    const previous = document.activeElement as HTMLElement | null;
    node?.showModal(); node?.querySelector<HTMLElement>('#settings-title')?.focus();
    return () => { node?.close(); if (previous?.isConnected) previous.focus(); };
  }, [open]);
  useEntrance(dialog, open, 'dialog');
  const props = { client, actions, state, workspaceId };
  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title" onCancel={e => { e.preventDefault(); if (!actions.busy) close(); }}>
    <header className="settings-heading"><div><h2 id="settings-title" tabIndex={-1}>{title}</h2>{mock && <span className="settings-note">演示模式 · 配置仅用于模拟</span>}</div><button className="icon-button" aria-label="关闭设置" disabled={actions.busy} onClick={close}>×</button></header>
    <div className="settings-layout"><nav aria-label="设置分类">{(Object.keys(sections) as SettingsSection[]).filter(s => !['launch', 'new-room'].includes(s)).map(s => <button key={s} disabled={actions.busy} aria-current={section === s ? 'page' : undefined} onClick={() => select(s)}>{sections[s]}{s === 'permissions' && state.approvals.length > 0 && <span className="settings-count">{state.approvals.length}</span>}</button>)}</nav>
      <div className="settings-body">
        {state.connection !== 'live' && <p role="status" className="settings-notice">连接已断开，恢复后才能保存配置。</p>}
        {actions.message && <p role="status" className="settings-notice">{actions.message}</p>}
        {actions.busy && <p role="status">正在提交，请稍候…</p>}
        {visited.map(s => <section key={s} hidden={section !== s} aria-label={sections[s]}>
          {s === 'connections' && <ConnectionSettings {...props} active={section === s} />}
          {s === 'capabilities' && <CapabilitySettings {...props} active={section === s} />}
          {s === 'usage' && <UsageSettings {...props} active={section === s} />}
          {s === 'workspaces' && <WorkspaceSettings {...props} active={section === s} selectWorkspace={selectWorkspace} />}
          {(s === 'launch' || s === 'new-room') && <CreationSettings {...props} active={section === s} kind={s} created={id => created(s, id)} />}
          {s === 'permissions' && <>
            <p className="settings-note">每个请求按引擎提供的范围授权。当前接口暂不支持修改全局授权策略。</p>
            <h3>待处理请求</h3>{!state.approvals.length && <p className="settings-empty">暂无待处理请求</p>}
            <div className="settings-list">{state.approvals.map(a => <div className="settings-row" key={a.id}><span><strong>{a.title || '需要确认'}</strong><small>{state.agents.find(agent => agent.id === a.agentId)?.displayName} · {a.scopeLabel}</small></span><button className="button" onClick={() => openRequest(a.id)}>查看请求</button></div>)}</div>
            <h3>确认记录</h3>{!state.approvalHistory.length && <p className="settings-empty">暂无确认记录</p>}
            <div className="settings-list">{[...state.approvalHistory].reverse().map(a => <div className="settings-row" key={a.id}><span><strong>{a.title}</strong><small>{a.scopeLabel} · {a.decision === 'allow' ? '已提交允许' : a.decision === 'deny' ? '已提交拒绝' : '未提交决定'}</small></span><span>{a.delivery === 'confirmed' ? '引擎已确认' : a.status === 'expired' ? '已失效' : '接收结果未知'}</span></div>)}</div>
          </>}
        </section>)}
      </div>
    </div>
  </dialog>;
}
