import React, { useState } from 'react';
import type { Agent, ChatClient } from './types';

export function MemberActions({ agent, client, live }: { agent: Agent; client: ChatClient; live: boolean }) {
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const act = async (type: 'stopAgent' | 'removeAgent') => {
    setBusy(true); setError('');
    try { await client.dispatch({ type, key: crypto.randomUUID(), agentId: agent.id }); setConfirm(false); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className="member-actions">{agent.status !== 'inactive' && <button className="button" disabled={!live || busy} onClick={() => void act('stopAgent')}>停止 Agent</button>}
    <button className="button" disabled={!live || busy} onClick={() => setConfirm(!confirm)}>移除 Agent</button>
    {confirm && <div role="group" aria-label={`移除 ${agent.displayName}`}><p>移除成员会停止其受托管会话，已有消息保留。</p><button className="button" disabled={busy} onClick={() => void act('removeAgent')}>确认移除</button></div>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
