import React, { useEffect, useId, useRef, useState } from 'react';
import type { ChatClient, Snapshot, Command } from './types';
import { consultationCommandTypes } from '../../contracts/consultations.mjs';
import './consultations.css';
type Question = Snapshot['consultations'][number];
export type ConsultationRequest = { taskId: string; questionId: string; questionRevision: number; nonce: string };
type Drafts = { title: string; instruction: string; agents: string[]; sourceTask: string; answers: Record<string, { revision: number; text: string }> };
const blank: Drafts = { title: '', instruction: '', agents: [], sourceTask: '', answers: {} };
const jobLabels: Record<string, string> = { queued: '排队中', paused: '尚未启动，等待明确恢复', dispatching: '正在启动', running: '正在分析', answered: '建议已返回，等待你决定', failed: '执行未完成', cancelling: '已请求中止，等待确认', cancelled: '已取消', unknown: '结果未知，不会重试', abandoned: '已明确放弃旧结果' };
function load(key: string): Drafts {
  try { const d = JSON.parse(localStorage.getItem(key) || 'null'); if (d && typeof d.title === 'string' && typeof d.instruction === 'string' && typeof d.sourceTask === 'string' && Array.isArray(d.agents) && d.agents.every((id: unknown) => typeof id === 'string') && d.answers && typeof d.answers === 'object') {
    const answers: Drafts['answers'] = {};
    for (const [id, a] of Object.entries(d.answers).slice(-100)) { const value = a as { revision: number; text: string }; if (value && Number.isInteger(value.revision) && typeof value.text === 'string') answers[id] = { revision: value.revision, text: value.text.slice(0,4000) }; }
    return { title: d.title.slice(0,500), instruction: d.instruction.slice(0,4000), sourceTask: d.sourceTask, agents: d.agents.slice(0,3), answers };
  } } catch {} return structuredClone(blank);
}
export function Consultations({ client, state, roomId, request }: { client: ChatClient; state: Snapshot; roomId: string; request: ConsultationRequest | null }) {
  const key = `ar-consultations:${JSON.stringify([state.backendId,state.databaseId,state.currentUserId,roomId])}`;
  const [drafts, setDrafts] = useState(() => load(key)), [busy,setBusy] = useState(false), [error,setError] = useState(''), [contexts,setContexts] = useState<Record<string,string>>({});
  const lock = useRef(false), creator = useRef<HTMLDialogElement>(null), title = useRef<HTMLTextAreaElement>(null);
  const [creating, setCreating] = useState(false), [historyOpen, setHistoryOpen] = useState(false);
  const dialogTitle = useId(), historyId = useId();
  useEffect(() => {
    if (!creating) return;
    const previous = document.activeElement as HTMLElement | null, dialog = creator.current;
    dialog?.showModal(); title.current?.focus();
    return () => { dialog?.close(); if (previous?.isConnected) previous.focus(); };
  }, [creating]);
  const questions = state.consultations.filter(q => q.roomId === roomId);
  const tasks = state.localTasks.filter(t => t.roomId === roomId && t.phase === 'awaiting_input' && t.question?.status === 'pending');
  const source = tasks.find(t => t.id === drafts.sourceTask);
  const choices = state.consultationAgents.filter(a => a.id !== source?.ownerAgentId);
  const pending = state.pendingOperations?.filter(p => consultationCommandTypes.includes(p.type || '')) || [];
  useEffect(() => { if (pending.length) setHistoryOpen(true); }, [pending.length]);
  const live = state.connection === 'live', enabled = Boolean(state.capabilities.consultations && live && !busy && !pending.length);
  useEffect(() => { if (state.backendId && state.databaseId && state.currentUserId) { try { localStorage.setItem(key, JSON.stringify(drafts)); } catch {} } }, [key,drafts]);
  useEffect(() => { if (!request) return; const t = tasks.find(t => t.id === request.taskId && t.question?.id === request.questionId && t.question.revision === request.questionRevision); if (!t) return;
    setDrafts(d => ({ ...d, sourceTask: t.id, title: t.question!.title, agents: d.agents.filter(id => id !== t.ownerAgentId) }));
    setCreating(true);
  }, [request?.nonce]);
  if (!state.capabilities.consultations && !questions.length) return null;
  async function act(action: () => Promise<unknown>) { if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { await action(); } catch(e) { setError((e as Error).message); } finally { lock.current = false; setBusy(false); } }
  const command = (type: 'decideConsultation'|'cancelConsultation'|'resumeConsultation'|'checkConsultation'|'abandonConsultation', q: Question, extra: object = {}) => client.dispatch({ type, key: crypto.randomUUID(), workspaceId: state.rooms.find(r => r.id === roomId)!.workspaceId, roomId, consultationId: q.id, expectedRevision: q.revision, ...extra } as Command);
  function prepare(q: Question) { setDrafts(d => ({ ...d, title: q.title, instruction: q.instruction, sourceTask: tasks.some(t => t.id === q.source?.taskId) ? q.source!.taskId : '', agents: q.assignments.map(a => a.agentId).filter(id => choices.some(a => a.id === id)) })); setCreating(true); }
  return <section className="consultations" aria-label="Agent 咨询">
    <header className="consultation-bar">
      <button type="button" className="consultation-history-toggle" aria-expanded={historyOpen} aria-controls={historyId} disabled={!questions.length && !pending.length && !error} onClick={() => setHistoryOpen(value => !value)}><svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20 11.5a8 8 0 0 1-8 8H5l-4 3V11.5a9.5 9.5 0 0 1 19 0Z" stroke="currentColor" strokeWidth="1.5"/><path d="M6 10h9M6 14h6" stroke="currentColor" strokeWidth="1.5"/></svg><span>Agent 咨询</span><span className="consultation-count">{questions.length}</span>{questions.some(q => q.status === 'pending' && q.assignments.some(a => a.status === 'answered')) && <span className="consultation-ready">有建议待决定</span>}</button>
      {state.capabilities.consultations && <button type="button" className="consultation-new" onClick={() => setCreating(true)}><span aria-hidden="true">＋</span> 发起咨询</button>}
    </header>
    {state.capabilities.consultations && <dialog ref={creator} className="consultation-creator" aria-labelledby={dialogTitle} onCancel={e => { e.preventDefault(); if (!busy) setCreating(false); }} onKeyDown={e => {
      if (e.key !== 'Tab' || e.defaultPrevented) return;
      const items = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex]:not([tabindex="-1"])')].filter(el => el.getClientRects().length > 0);
      const first = items[0], last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }}>
      <header className="consultation-dialog-heading"><div><h2 id={dialogTitle}>发起咨询</h2><p>邀请 Agent 分析问题，由你决定采用哪条建议。</p></div><button type="button" className="consultation-close" aria-label="关闭咨询窗口" disabled={busy} onClick={() => setCreating(false)}>×</button></header>
      <form onSubmit={e => { e.preventDefault(); if (!enabled || !drafts.title.trim() || !drafts.agents.length || drafts.agents.some(id => !choices.some(a => a.id === id)) || drafts.sourceTask && !source) return;
        const original = { ...drafts }; void act(async () => { await client.dispatch({ type: 'createConsultation', key: crypto.randomUUID(), roomId, workspaceId: state.rooms.find(r => r.id === roomId)!.workspaceId, title: original.title, instruction: original.instruction, agentIds: original.agents, source: source ? { taskId: source.id, questionId: source.question!.id, questionRevision: source.question!.revision } : null }); setDrafts(d => d.title === original.title && d.instruction === original.instruction ? { ...d, title: '', instruction: '', sourceTask: '' } : d); setCreating(false); setHistoryOpen(true); }); }}>
        <div className="consultation-fields">
        <label className="consultation-question">想咨询什么？<textarea ref={title} aria-label="咨询问题" placeholder="描述遇到的问题，或希望比较的方案…" maxLength={500} rows={3} value={drafts.title} onChange={e => setDrafts(d => ({ ...d,title:e.target.value }))} /></label>
        <details className="consultation-options" open={Boolean(drafts.sourceTask) || undefined}><summary>补充背景与分析要求 <span>可选</span></summary>
        <label>关联来源<select aria-label="咨询来源" value={drafts.sourceTask} onChange={e => { const t = tasks.find(t => t.id === e.target.value); setDrafts(d => ({ ...d, sourceTask: e.target.value, title: t?.question?.title || d.title, agents: d.agents.filter(id => id !== t?.ownerAgentId) })); }}><option value="">独立咨询问题</option>{tasks.map(t => <option key={t.id} value={t.id}>{t.question?.title}</option>)}{drafts.sourceTask && !source && <option value={drafts.sourceTask}>原问题已失效，请重新选择来源</option>}</select></label>
        <label>分析要求<textarea aria-label="咨询分析要求" placeholder="例如：重点比较实现成本、风险和维护难度" maxLength={4000} rows={2} value={drafts.instruction} onChange={e => setDrafts(d => ({ ...d,instruction:e.target.value }))} /></label>
        </details>
        <fieldset disabled={!enabled}><legend>选择顾问 <span>已选 {drafts.agents.length}/3</span></legend><div className="consultation-agent-grid">{choices.map(a => <label key={a.id} className={drafts.agents.includes(a.id) ? "is-selected" : ""}><input type="checkbox" aria-label={`咨询 ${a.displayName}`} checked={drafts.agents.includes(a.id)} disabled={drafts.agents.length >= 3 && !drafts.agents.includes(a.id)} onChange={e => setDrafts(d => ({ ...d, agents: e.target.checked ? [...d.agents,a.id] : d.agents.filter(id => id !== a.id) }))} /><span className="consultation-agent-mark" aria-hidden="true">{a.displayName.slice(0,1)}</span><span>{a.displayName}<small>{a.model}</small></span></label>)}</div>{!choices.length && <p className="consultation-note">暂无可用顾问。请先配置咨询 Agent。</p>}</fieldset>
        <div className="consultation-terms"><p>仅提供建议，不更改负责人或工具权限。</p><p>每题最多启动 3 次 · 10 分钟有效 · 费用按所配置模型服务计算</p></div>
        {error && <p className="consultation-form-error" role="alert">{error}</p>}
        </div>
        <footer className="consultation-submit"><span>{busy ? '正在发起咨询…' : '关闭窗口后保留草稿'}</span><button className="button" data-create-consultation disabled={!enabled || !drafts.title.trim() || !drafts.agents.length || drafts.agents.some(id => !choices.some(a => a.id === id)) || Boolean(drafts.sourceTask && !source)}>{busy ? '正在发起…' : '发起咨询'}</button></footer>
      </form>
    </dialog>}
    <div id={historyId} className="consultations-body" hidden={!historyOpen}>
    {pending.map(p => <div className="consultation-notice" key={p.key} role="status">原咨询请求待核查。<button className="button" data-check-consultation-operation disabled={!live || busy} onClick={() => void act(async () => { if (!await client.checkOperation?.(p.key,p.type)) setError('尚未找到原请求，可以显式重试保存的原请求。'); })}>核查原咨询请求</button>{p.outcome === 'not_found' && <button className="button" disabled={!live || busy} onClick={() => void act(async () => { await client.retryOperation?.(p.key); })}>重试保存的原请求</button>}</div>)}
    {questions.map(q => <article key={q.id} data-consultation-id={q.id} data-consultation-state={q.status}>
      <header><strong>{q.title}</strong><span role="status">{({ pending:'等待你的决定', resolved:'决定已记录', cancelled:'已撤销', expired:'已过期' })[q.status]}</span></header>
      <p className="consultation-note">启动预算 {q.startsUsed}/3 · 有效至 {new Date(q.expiresAt).toLocaleTimeString()}{q.source ? ` · 来源任务负责人：${q.source.ownerAgentId}` : ' · 独立问题'}</p>
      {q.instruction && <p>{q.instruction}</p>}
      {q.assignments.map(a => <section key={a.id} data-consultation-assignment={a.id} data-assignment-status={a.status}>
        <strong>{state.consultationAgents.find(agent => agent.id === a.agentId)?.displayName || a.agentId}</strong><span role="status">{jobLabels[a.status]}</span>
        {a.text && <pre>{a.text}</pre>}{a.note && <p className="consultation-note">{a.note}</p>}
        {a.status === 'answered' && q.status === 'pending' && <button className="button" data-adopt-consultation disabled={!enabled} onClick={() => void act(async () => { await command('decideConsultation',q,{ adoptedAssignmentId:a.id }); })}>采用此建议</button>}
        {a.status === 'paused' && q.status === 'pending' && <button className="button" data-resume-consultation disabled={!enabled} onClick={() => void act(async () => { await command('resumeConsultation',q,{ assignmentId:a.id }); })}>明确恢复尚未开始的咨询</button>}
        {a.status === 'unknown' && <><button className="button" data-inspect-consultation disabled={!enabled} onClick={() => void act(async () => { await command('checkConsultation',q,{ assignmentId:a.id }); })}>核查原进程</button><button className="button" data-abandon-consultation disabled={!enabled || a.leaseHeld || !a.stopConfirmed} onClick={() => void act(async () => { await command('abandonConsultation',q,{ assignmentId:a.id }); })}>放弃旧执行结果</button></>}
        {a.contextSnapshotId && <details><summary>查看本次上下文</summary>{contexts[a.id] ? <pre className="consultation-context">{contexts[a.id]}</pre> : <button className="button" disabled={!live || busy} onClick={() => void act(async () => { const context = await client.query({ type:'consultationContext',roomId,consultationId:q.id,assignmentId:a.id }); setContexts(old => ({ ...old,[a.id]:JSON.stringify(context,null,2) })); })}>读取已保存快照</button>}</details>}
      </section>)}
      {q.response ? <div role="status"><p>你的决定：{q.response.text}</p>{q.response.delivery === 'recorded' && <p>已通过原任务答复契约记录，投递进度见原任务。</p>}{q.response.delivery === 'unavailable' && <p>原生会话已失效，决定已保留，未向旧会话投递。</p>}</div> : q.status === 'pending' && <form onSubmit={e => { e.preventDefault(); const text = drafts.answers[q.id]?.text || ''; if (enabled && text.trim()) void act(async () => { await command('decideConsultation',q,{ text }); }); }}>
        <label>你的决定<textarea aria-label={`咨询决定 ${q.id}`} maxLength={4000} rows={2} value={drafts.answers[q.id]?.text || ''} onChange={e => setDrafts(d => ({ ...d, answers:{...d.answers,[q.id]:{revision:q.revision,text:e.target.value}} }))} /></label><button className="button" data-decide-consultation disabled={!enabled || !drafts.answers[q.id]?.text.trim()}>提交自己的决定</button>
      </form>}
      <div className="consultation-actions">{q.status === 'pending' ? <button className="button" data-cancel-consultation disabled={!enabled} onClick={() => void act(async () => { await command('cancelConsultation',q); })}>撤销本轮咨询</button> : <button className="button" disabled={!enabled} onClick={() => prepare(q)}>填写新一轮咨询</button>}</div>
    </article>)}
    {error && !creating && <p role="alert">{error}</p>}
  </div></section>;
}
