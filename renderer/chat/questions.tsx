import React, { useRef, useState } from 'react';
import type { z } from 'zod';
import type { collaborationQuestionSchema } from '../../contracts/questions.mjs';
import type { Agent, ChatClient, Command } from './types';
import './questions.css';
export type Question = z.infer<typeof collaborationQuestionSchema>;
export type QuestionDraft = { revision: number; optionIds: string[]; text: string; unknownKey?: string; adviceAgentIds?: string[]; adviceText?: string };
export function QuestionInteraction({ question: q, client, userId, draft, update, members = [], adviceEnabled = false }: { question: Question; client: ChatClient; userId: string; draft: QuestionDraft; update(value: QuestionDraft): void; members?: Agent[]; adviceEnabled?: boolean }) {
  const panel = useRef<HTMLDetailsElement>(null), picker = useRef<HTMLDetailsElement>(null), lock = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const eligible = q.canAnswer && q.recipientId === userId;
  const blocked = busy || Boolean(draft.unknownKey) || !eligible || q.status !== 'pending' || draft.revision !== q.revision || client.read().connection !== 'live';
  const summary = q.response ? `${q.response.authorId === userId ? '你已答复' : '其他成员已答复'}：${[...q.response.optionIds.map(id => q.options.find(o => o.id === id)?.label), q.response.text].filter(Boolean).join('，')}` : q.status === 'expired' ? '问题已过期' : q.status === 'revoked' ? '问题已撤销' : !eligible ? '等待指定成员回答' : '1 个需要你确认';
  const close = () => { if (panel.current) { panel.current.open = false; panel.current.querySelector('summary')?.focus(); } };
  async function perform(command: Command, closeAfter = true) {
    if (lock.current || blocked) return;
    lock.current = true; setBusy(true); setError('');
    try { await client.dispatch(command); if (closeAfter) close(); else if (picker.current) { picker.current.open = false; picker.current.querySelector('summary')?.focus(); } }
    catch (e) { const failure = e as Error & { outcome?: string }; if (failure.outcome === 'unknown' && 'key' in command) update({ ...draft, unknownKey: command.key }); setError(failure.message); }
    finally { lock.current = false; setBusy(false); }
  }
  function submit() {
    if (!draft.optionIds.length && !draft.text.trim()) return;
    return perform({ type: 'answerQuestion', key: crypto.randomUUID(), questionId: q.id, expectedRevision: draft.revision, optionIds: draft.optionIds, text: draft.text });
  }
  async function check() {
    if (lock.current || !draft.unknownKey) return;
    lock.current = true; setBusy(true); setError('');
    try { const r = await client.query({ type: 'questionOperation', questionId: q.id, key: draft.unknownKey }); if (r.found) { update({ ...draft, unknownKey: undefined }); close(); } else setError('尚未找到原请求回执，继续保留待核查状态。'); }
    catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  return <details ref={panel} className="question-interaction" data-question-id={q.id} onToggle={e => { if (e.target === e.currentTarget && e.currentTarget.open) e.currentTarget.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), button:not(:disabled)')?.focus(); }} onKeyDown={e => { if (e.key === 'Escape' && !(e.nativeEvent.isComposing || e.keyCode === 229)) { e.stopPropagation(); e.preventDefault(); close(); } }}>
    <summary>{summary}{q.response && <span> · 查看详情</span>}</summary>
    <div className="question-body"><h3>{q.title}</h3><p>{q.description}</p>
      {q.response && <p role="status">答复已记录。本地示例，不代表 Agent 已继续执行。</p>}
      {q.status !== 'pending' && !q.response && <p role="status">该请求已失效，填写内容保留供查看。</p>}
      {draft.revision !== q.revision && q.status === 'pending' && <p role="status">问题已更新，原填写内容已保留。<button type="button" className="button" disabled={busy || Boolean(draft.unknownKey)} onClick={() => update({ ...draft, revision: q.revision, optionIds: draft.optionIds.filter(id => q.options.some(o => o.id === id)) })}>核对后使用最新问题</button></p>}
      <form onSubmit={e => { e.preventDefault(); void submit(); }}><fieldset disabled={blocked}><legend>{q.multiple ? '选择方案（可多选，也可直接输入）' : '选择方案（也可直接输入）'}</legend>
        {q.options.map(o => <label key={o.id}><input type={q.multiple ? 'checkbox' : 'radio'} name={`question-${q.id}`} value={o.id} checked={draft.optionIds.includes(o.id)} onChange={e => update({ ...draft, optionIds: q.multiple ? e.target.checked ? [...draft.optionIds, o.id] : draft.optionIds.filter(id => id !== o.id) : [o.id] })} />{o.label}</label>)}
        {draft.optionIds.length > 0 && <button type="button" className="button" onClick={() => update({ ...draft, optionIds: [] })}>清除选择</button>}
        <label className="question-free-text"><span>补充说明或输入其他方案</span><textarea aria-label="补充说明或输入其他方案" value={draft.text} maxLength={4000} rows={3} onChange={e => update({ ...draft, text: e.target.value })} /></label>
      </fieldset>{q.status === 'pending' && <button type="submit" className="button primary" disabled={blocked || (!draft.optionIds.length && !draft.text.trim())}>{busy ? '正在提交…' : '提交答复'}</button>}</form>
      {adviceEnabled && <section className="question-advice" aria-label="Agent 建议">
        {q.status === 'pending' && <details ref={picker}><summary>请 Agent 提供建议</summary><fieldset disabled={blocked}><legend>选择回答的 Agent（可多选）</legend>{members.map(a => <label key={a.id}><input type="checkbox" aria-label={`请 ${a.displayName}（${a.engine} Agent）回答`} checked={draft.adviceAgentIds?.includes(a.id) || false} onChange={e => update({ ...draft, adviceAgentIds: e.target.checked ? [...(draft.adviceAgentIds || []), a.id] : (draft.adviceAgentIds || []).filter(id => id !== a.id) })} />{a.displayName}<small>{a.engine} · Agent</small></label>)}
          <label className="question-free-text"><span>分析要求（可选）</span><textarea aria-label="分析要求" rows={2} maxLength={4000} value={draft.adviceText || ''} onChange={e => update({ ...draft, adviceText: e.target.value })} /></label>
          <button type="button" className="button" disabled={!draft.adviceAgentIds?.length || draft.adviceAgentIds.some(id => !members.some(a => a.id === id))} onClick={() => void perform({ type: 'requestQuestionAdvice', key: crypto.randomUUID(), questionId: q.id, expectedRevision: draft.revision, expectedAdviceGeneration: q.adviceGeneration, agentIds: draft.adviceAgentIds || [], instruction: draft.adviceText || '' }, false)}>{q.adviceGeneration ? '重新指派建议' : '请求建议'}</button>
        </fieldset></details>}
        {q.advices.map(a => {
          const member = members.find(m => m.id === a.agentId), current = a.generation === q.adviceGeneration && a.questionRevision === q.revision && Boolean(member);
          return <article key={a.id} data-advice-id={a.id}><strong>{members.find(m => m.id === q.authorId)?.displayName || q.authorId} → @{member?.displayName || a.agentId} · Agent 建议</strong><span>{!current ? '历史建议' : ({ waiting: '等待回答', answered: '已回答，等待你决定', failed: '无法回答', unknown: '结果未知，需核查', revoked: '请求已撤销' })[a.status]}</span>
            {a.instruction && <p>分析要求：{a.instruction}</p>}{a.text && <p>{a.text}</p>}
            {a.status === 'answered' && current && q.status === 'pending' && <div className="question-advice-actions"><button className="button" disabled={blocked} onClick={() => void perform({ type: 'adoptQuestionAdvice', key: crypto.randomUUID(), questionId: q.id, expectedRevision: draft.revision, expectedAdviceGeneration: q.adviceGeneration, adviceId: a.id })}>采用建议</button><button className="button" onClick={() => panel.current?.querySelector<HTMLTextAreaElement>('.question-free-text textarea')?.focus()}>输入其他方案</button></div>}
          </article>;
        })}
        {q.response?.adoptedAdviceId && <p>你已采纳关联建议；任务负责人保持不变。</p>}
      </section>}
      {draft.unknownKey && <div role="status"><p>正在确认原请求的接收结果，请勿重复提交。</p><button className="button" disabled={busy || client.read().connection !== 'live'} onClick={() => void check()}>核查原答复</button></div>}
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}
