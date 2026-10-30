import React, { useEffect, useRef, useState } from 'react';
import type { Approval, ChatClient, Snapshot } from './types';
import { useEntrance } from './motion';

type AnswerDraft = { answers: Record<string, string[]>; custom: Record<string, string>; other: Record<string, boolean>; value: string };
type Request = Approval & { status?: string; delivery?: string; allowedDecisions?: string[] };
const emptyDraft = (): AnswerDraft => ({ answers: {}, custom: {}, other: {}, value: '' });
export function ApprovalCenter({ client, state, activeRoomId }: { client: ChatClient; state: Snapshot; activeRoomId?: string }) {
  const [snoozed, setSnoozed] = useState(false), [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  const [submitted, setSubmitted] = useState<Record<string, { revision: number; outcome: 'accepted' | 'unknown' }>>({});
  const requests = state.approvals as Request[];
  const history = (state.approvalHistory || []).filter(r => !activeRoomId || r.roomId === activeRoomId);
  const current = requests.find(a => a.id === selected) || (!snoozed ? requests.find(a => !activeRoomId || a.roomId === activeRoomId) : undefined);
  useEffect(() => { setSelected(current?.id || null); }, [current?.id]);
  useEffect(() => {
    const ids = new Set(requests.map(a => a.id));
    setDrafts(old => Object.fromEntries(Object.entries(old).filter(([id]) => ids.has(id))));
    setSubmitted(old => Object.fromEntries(Object.entries(old).filter(([id]) => ids.has(id))));
  }, [state.approvals]);
  return <>
    {history.length > 0 && <details className="approval-history"><summary>确认记录 · {history.length}</summary>{history.map(r => <p key={r.id}><strong>{r.title}</strong> · {r.decision === 'allow' ? '已提交允许' : r.decision === 'deny' ? '已提交拒绝' : '未提交决定'} · {r.delivery === 'confirmed' ? '引擎已确认接收' : r.status === 'expired' ? '请求已失效' : '接收结果未知，不会重复提交'}</p>)}</details>}
    {requests.length > 0 && <button className="permission-badge" onClick={() => { setSnoozed(false); setSelected(requests.find(r => r.roomId === activeRoomId)?.id || requests[0].id); }}>待确认 · {requests.length}</button>}
    {current && <ApprovalDialog key={`${current.id}:${current.revision}`} request={current} agentName={state.agents.find(a => a.id === current.agentId)?.displayName || current.agentId}
      roomTitle={state.rooms.find(r => r.id === current.roomId)?.title || '会话未关联'} remaining={requests.length}
      submitted={submitted[current.id]?.revision === current.revision ? submitted[current.id]?.outcome : undefined}
      markSubmitted={outcome => setSubmitted(old => ({ ...old, [current.id]: { revision: current.revision, outcome } }))}
      client={client} live={state.connection === 'live'} draft={drafts[current.id] || emptyDraft()}
      setDraft={value => setDrafts(old => ({ ...old, [current.id]: value }))}
      later={() => { setSnoozed(true); setSelected(null); }} />}
  </>;
}
function ApprovalDialog({ request, agentName, roomTitle, remaining, submitted, markSubmitted, client, draft, setDraft, later, live }: {
  request: Request; agentName: string; client: ChatClient; draft: AnswerDraft; setDraft(value: AnswerDraft): void; later(): void; live: boolean;
  roomTitle: string; remaining: number; submitted?: 'accepted' | 'unknown'; markSubmitted(outcome: 'accepted' | 'unknown'): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), busyRef = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const permission = request.kind === 'permission';
  const pending = (!request.status || request.status === 'pending') && (!request.delivery || request.delivery === 'pending');
  const blocked = busy || !live || Boolean(submitted) || !pending;
  const canDecide = (allow: boolean) => !request.allowedDecisions || request.allowedDecisions.includes(allow ? 'allow' : 'deny');
  const scopeAction = request.scopeLabel.includes('轮') ? '允许本轮' : '允许本次';
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null, element = dialog.current;
    element?.showModal();
    // Focus the request, never the affirmative decision.
    element?.querySelector<HTMLElement>('#approval-title')?.focus();
    return () => { element?.close(); if (previous?.isConnected) previous.focus(); };
  }, []);
  useEntrance(dialog, true, 'dialog');
  async function decide(allow: boolean) {
    if (busyRef.current || blocked || !canDecide(allow)) return;
    const answers = request.questions.map(q => {
      const selected = (draft.answers[q.id] || []).filter(value => q.options.includes(value));
      const custom = draft.custom[q.id]?.trim();
      if (q.multiple) return [...new Set(custom ? [...selected, custom] : selected)];
      return draft.other[q.id] || !q.options.length ? custom ? [custom] : [] : selected.slice(0, 1);
    });
    if (allow && request.kind === 'questions' && (!request.questions.length || answers.some(a => !a.length))) { setError('请完成每个问题后再提交。'); return; }
    if (allow && request.kind === 'input' && !draft.value.trim()) { setError('请填写回答。'); return; }
    busyRef.current = true; setBusy(true); setError('');
    try { await client.dispatch({ type: 'decide', approvalId: request.id, expectedRevision: request.revision, allow, answers, value: draft.value.trim() }); markSubmitted('accepted'); }
    catch (e) { const failure = e as Error & { outcome?: string }; if (failure.outcome === 'unknown') markSubmitted('unknown'); setError(failure.message); }
    finally { busyRef.current = false; setBusy(false); }
  }
  const outcome = submitted === 'unknown' || request.delivery === 'unknown' || request.status === 'unknown' ? '答复结果未知，已暂停重复提交。请核查会话状态。'
    : submitted || request.delivery === 'submitted' || request.status === 'submitting' ? '答复已提交，正在等待引擎确认。'
    : !pending ? '此请求已结束，不能再次提交。' : '';
  return <dialog ref={dialog} className={`permission-dialog ${permission ? 'approval-permission' : 'approval-question'}`} aria-labelledby="approval-title" aria-describedby="approval-source" onCancel={e => { e.preventDefault(); if (!busy) later(); }}>
    <div className="permission-heading"><div><p className="approval-kicker">{permission ? '操作授权' : 'Agent 提问'}</p><h2 id="approval-title" tabIndex={-1}>{request.title || (permission ? '是否允许此次操作？' : '需要你的回答')}</h2></div><button type="button" className="button" disabled={busy} onClick={later}>稍后处理</button></div>
    <p className="approval-source" id="approval-source"><strong>{agentName}</strong><span>{roomTitle}</span>{remaining > 1 && <span>还有 {remaining - 1} 项待处理</span>}</p>
    {permission && <><dl className="approval-facts"><div><dt>授权范围</dt><dd className="approval-scope">{request.scopeLabel}</dd></div>{request.directory && <div><dt>工作目录</dt><dd className="permission-context">{request.directory}</dd></div>}</dl>{request.summary && <div className="approval-operation"><span>操作内容</span><p>{request.summary.trim().split(/\r?\n/)[0].slice(0, 160)}{request.summary.trim().split(/\r?\n/)[0].length > 160 ? '…' : ''}</p><details><summary>查看完整操作</summary><pre className="rpc-request-detail">{request.summary}</pre></details></div>}</>}
    {!permission && request.summary && <details className="approval-context"><summary>查看请求说明</summary><pre className="rpc-request-detail">{request.summary}</pre></details>}
    {request.questions.map((q, index) => <fieldset key={q.id} disabled={blocked}><legend>{request.questions.length > 1 && `${index + 1}. `}{q.title}<span className="question-mode">{q.multiple ? '可多选' : q.options.length ? '单选' : '文字回答'}</span></legend>
      {q.options.map((option, optionIndex) => <label key={`${q.id}:${optionIndex}`} className={`permission-option ${(draft.answers[q.id] || []).includes(option) && !draft.other[q.id] ? 'is-chosen' : ''}`}>
        <input type={q.multiple ? 'checkbox' : 'radio'} name={`answer-${request.id}-${q.id}`} checked={(q.multiple || !draft.other[q.id]) && (draft.answers[q.id] || []).includes(option)} onChange={e => {
          const values = q.multiple ? e.target.checked ? [...(draft.answers[q.id] || []), option] : (draft.answers[q.id] || []).filter(v => v !== option) : [option];
          setDraft({ ...draft, answers: { ...draft.answers, [q.id]: values }, other: { ...draft.other, [q.id]: false } });
        }} /><span>{option}</span>
      </label>)}
      {!q.multiple && q.options.length > 0 && <label className={`permission-option ${draft.other[q.id] ? 'is-chosen' : ''}`}><input type="radio" name={`answer-${request.id}-${q.id}`} checked={Boolean(draft.other[q.id])} onChange={() => setDraft({ ...draft, other: { ...draft.other, [q.id]: true }, answers: { ...draft.answers, [q.id]: [] } })} /><span>其他答案</span></label>}
      {(q.multiple || !q.options.length || draft.other[q.id]) && <label className="question-custom"><span>{q.multiple ? '补充回答（可选）' : '你的回答'}</span><textarea className="text-input" aria-label={`${q.title} ${q.multiple ? '补充回答' : '其他答案'}`} rows={2} maxLength={4000} value={draft.custom[q.id] || ''} onChange={e => setDraft({ ...draft, custom: { ...draft.custom, [q.id]: e.target.value } })} /></label>}
    </fieldset>)}
    {request.kind === 'questions' && !request.questions.length && <p role="alert" className="permission-error">问题内容尚未完整，暂时无法提交。可以稍后处理。</p>}
    {request.kind === 'input' && <label className="question-custom"><span>你的回答</span>{request.options.length ? <select aria-label="回答" value={draft.value} disabled={blocked} onChange={e => setDraft({ ...draft, value: e.target.value })}><option value="">选择回答</option>{request.options.map(o => <option key={o}>{o}</option>)}</select> : <textarea aria-label="回答" className="text-input" rows={3} disabled={blocked} value={draft.value} maxLength={16000} onChange={e => setDraft({ ...draft, value: e.target.value })} />}</label>}
    {!live && <p role="status">连接已断开，草稿已保留，恢复后可提交。</p>}
    {error && <p role="alert" className="permission-error">{error}</p>}
    {outcome && <p role="status" className="approval-outcome">{outcome}</p>}
    <div className="permission-actions"><button type="button" className="button" disabled={blocked || !canDecide(false)} onClick={() => void decide(false)}>{permission ? '拒绝' : '取消回答'}</button><button type="button" className="button primary" disabled={blocked || !canDecide(true) || request.kind === 'questions' && !request.questions.length} onClick={() => void decide(true)}>{busy ? '提交中…' : permission ? scopeAction : '提交回答'}</button></div>
  </dialog>;
}
