import React, { useEffect, useRef, useState } from 'react';
import type { Approval, ChatClient, Snapshot } from './types';

type AnswerDraft = { answers: Record<string, string[]>; custom: Record<string, string>; value: string };
export function ApprovalCenter({ client, state }: { client: ChatClient; state: Snapshot }) {
  const [deferred, setDeferred] = useState<string[]>([]), [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  const current = state.approvals.find(a => a.id === selected) || state.approvals.find(a => !deferred.includes(a.id));
  useEffect(() => {
    const ids = new Set(state.approvals.map(a => a.id));
    setDeferred(old => old.filter(id => ids.has(id)));
    setDrafts(old => Object.fromEntries(Object.entries(old).filter(([id]) => ids.has(id))));
  }, [state.approvals]);
  return <>
    {state.approvals.length > 0 && <button className="permission-badge" onClick={() => { setDeferred([]); setSelected(state.approvals[0].id); }}>待确认 · {state.approvals.length}</button>}
    {current && <ApprovalDialog key={current.id} request={current} agentName={state.agents.find(a => a.id === current.agentId)?.displayName || current.agentId}
      client={client} live={state.connection === 'live'} draft={drafts[current.id] || { answers: {}, custom: {}, value: '' }}
      setDraft={value => setDrafts(old => ({ ...old, [current.id]: value }))}
      later={() => { setDeferred(old => [...old, current.id]); setSelected(null); }} />}
  </>;
}
function ApprovalDialog({ request, agentName, client, draft, setDraft, later, live }: {
  request: Approval; agentName: string; client: ChatClient; draft: AnswerDraft; setDraft(value: AnswerDraft): void; later(): void; live: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null), busyRef = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  async function decide(allow: boolean) {
    if (busyRef.current || !live) return;
    const answers = request.questions.map(q => {
      const selected = draft.answers[q.id] || [], custom = draft.custom[q.id]?.trim();
      return custom ? q.multiple ? [...selected, custom] : [custom] : selected;
    });
    if (allow && request.kind === 'questions' && answers.some(a => !a.length)) { setError('请回答每个问题。'); return; }
    if (allow && request.kind === 'input' && !draft.value.trim()) { setError('请填写回答。'); return; }
    busyRef.current = true; setBusy(true); setError('');
    try { await client.dispatch({ type: 'decide', approvalId: request.id, expectedRevision: request.revision, allow, answers, value: draft.value }); }
    catch (e) { setError((e as Error).message); }
    finally { busyRef.current = false; setBusy(false); }
  }
  return <dialog ref={dialog} className="permission-dialog" aria-labelledby="approval-title" onCancel={e => { e.preventDefault(); if (!busy) later(); }}>
    <div className="permission-heading"><h2 id="approval-title">{request.kind === 'permission' ? '操作需要确认' : '需要你的回答'}</h2><button className="button" disabled={busy} onClick={later}>稍后处理</button></div>
    <p className="approval-source">{agentName} · {request.scopeLabel}</p><h3>{request.title}</h3>
    <p className="permission-context">{request.directory}</p>
    <pre className="rpc-request-detail">{request.summary}</pre>
    {request.questions.map(q => <fieldset key={q.id} disabled={busy}><legend>{q.title}</legend>{q.options.map(option => <label key={option} className="permission-option">
      <input type={q.multiple ? 'checkbox' : 'radio'} name={q.id} checked={(draft.answers[q.id] || []).includes(option)} onChange={e => {
        const values = q.multiple ? e.target.checked ? [...draft.answers[q.id] || [], option] : (draft.answers[q.id] || []).filter(v => v !== option) : [option];
        setDraft({ ...draft, answers: { ...draft.answers, [q.id]: values } });
      }} /><span>{option}</span></label>)}<input className="text-input" aria-label={`${q.title} 补充回答`} placeholder="补充回答" maxLength={4000} value={draft.custom[q.id] || ''} onChange={e => setDraft({ ...draft, custom: { ...draft.custom, [q.id]: e.target.value } })} /></fieldset>)}
    {request.kind === 'input' && (request.options.length ? <select aria-label="回答" value={draft.value} disabled={busy} onChange={e => setDraft({ ...draft, value: e.target.value })}><option value="">选择回答</option>{request.options.map(o => <option key={o}>{o}</option>)}</select> : <textarea aria-label="回答" className="text-input" disabled={busy} value={draft.value} maxLength={16000} onChange={e => setDraft({ ...draft, value: e.target.value })} />)}
    {!live && <p role="status">连接已断开，恢复后可提交。</p>}
    {error && <p role="alert" className="permission-error">{error}</p>}
    <div className="permission-actions"><button className="button" disabled={busy || !live} onClick={() => void decide(false)}>拒绝</button><button className="button primary" disabled={busy || !live} onClick={() => void decide(true)}>{busy ? '提交中…' : request.kind === 'permission' ? '允许本次' : '提交回答'}</button></div>
  </dialog>;
}
