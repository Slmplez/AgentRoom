import React, { useEffect, useRef, useState } from 'react';
import type { Agent, ChatClient } from './types';

export function MemberActions({ agent, client, live, children }: { agent: Agent; client: ChatClient; live: boolean; children: React.ReactNode }) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const menu = useRef<HTMLDetailsElement>(null), cancel = useRef<HTMLButtonElement>(null);
  const closeMenu = () => { if (menu.current) menu.current.open = false; };
  const restoreFocus = () => menu.current?.querySelector('summary')?.focus();
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) closeMenu(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  useEffect(() => { if (confirm) cancel.current?.focus(); }, [confirm]);
  const act = async (type: 'stopAgent' | 'removeAgent') => {
    if (!live || busy) return;
    setBusy(true); setError('');
    try { await client.dispatch({ type, key: crypto.randomUUID(), agentId: agent.id }); setConfirm(false); closeMenu(); restoreFocus(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="member-entry" aria-label={agent.displayName} onKeyDown={event => {
    if (event.key === 'Escape' && (confirm || menu.current?.open)) {
      event.stopPropagation(); if (busy) return; setConfirm(false); closeMenu(); restoreFocus();
    }
  }}>
    <div className="member-row">{children}<details ref={menu} className="member-menu" onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node)) closeMenu();
    }}>
      <summary aria-label={`${agent.displayName} 的更多操作`} title="更多操作"><svg width="18" height="18" viewBox="0 0 18 18" fill="currentColor" aria-hidden="true"><circle cx="4" cy="9" r="1.3" /><circle cx="9" cy="9" r="1.3" /><circle cx="14" cy="9" r="1.3" /></svg></summary>
      <div className="member-menu-content">
        {agent.status !== 'inactive' && <button disabled={!live || busy} onClick={() => void act('stopAgent')}>停止会话<small>保留成员及已有消息</small></button>}
        <button className="member-danger" disabled={!live || busy} onClick={() => { setError(''); setConfirm(true); closeMenu(); }}>从工作区移除…<small>影响该 Agent 所在的房间</small></button>
      </div>
    </details></div>
    {confirm && <div className="member-confirm" role="group" aria-label={`移除 ${agent.displayName}`}>
      <strong>移除 {agent.displayName}？</strong><p>将从工作区移除并停止其托管会话，已有消息保留。</p>
      <div><button ref={cancel} className="button" disabled={busy} onClick={() => { setConfirm(false); setError(''); restoreFocus(); }}>取消</button><button className="button member-danger" disabled={!live || busy} onClick={() => void act('removeAgent')}>{busy ? '正在移除…' : '确认移除'}</button></div>
    </div>}
    {error && <p className="member-error" role="alert">{error}</p>}
    {busy && !confirm && <p className="member-feedback" role="status">正在停止会话…</p>}
  </section>;
}
