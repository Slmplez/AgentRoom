import React, { useRef, useState } from 'react';
import type { z } from 'zod';
import type { collaborationQuestionSchema } from '../../contracts/questions.mjs';
import type { ChatClient } from './types';
import './questions.css';
export type Question = z.infer<typeof collaborationQuestionSchema>;
export type QuestionDraft = { revision: number; optionIds: string[]; text: string; unknownKey?: string };
export function QuestionInteraction({ question: q, client, userId, draft, update }: { question: Question; client: ChatClient; userId: string; draft: QuestionDraft; update(value: QuestionDraft): void }) {
  const panel = useRef<HTMLDetailsElement>(null), lock = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const eligible = q.canAnswer && q.recipientId === userId;
  const blocked = busy || Boolean(draft.unknownKey) || !eligible || q.status !== 'pending' || draft.revision !== q.revision || client.read().connection !== 'live';
  const summary = q.response ? `${q.response.authorId === userId ? '你已答复' : '其他成员已答复'}：${[...q.response.optionIds.map(id => q.options.find(o => o.id === id)?.label), q.response.text].filter(Boolean).join('，')}` : q.status === 'expired' ? '问题已过期' : q.status === 'revoked' ? '问题已撤销' : !eligible ? '等待指定成员回答' : '1 个需要你确认';
  const close = () => { if (panel.current) { panel.current.open = false; panel.current.querySelector('summary')?.focus(); } };
  async function submit() {
    if (lock.current || blocked || (!draft.optionIds.length && !draft.text.trim())) return;
    lock.current = true; setBusy(true); setError(''); const key = crypto.randomUUID();
    try { await client.dispatch({ type: 'answerQuestion', key, questionId: q.id, expectedRevision: draft.revision, optionIds: draft.optionIds, text: draft.text }); close(); }
    catch (e) { const failure = e as Error & { outcome?: string }; if (failure.outcome === 'unknown') update({ ...draft, unknownKey: key }); setError(failure.message); }
    finally { lock.current = false; setBusy(false); }
  }
  async function check() {
    if (lock.current || !draft.unknownKey) return;
    lock.current = true; setBusy(true); setError('');
    try { const r = await client.query({ type: 'questionOperation', questionId: q.id, key: draft.unknownKey }); if (r.found) { update({ ...draft, unknownKey: undefined }); close(); } else setError('尚未找到原请求回执，继续保留待核查状态。'); }
    catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  return <details ref={panel} className="question-interaction" data-question-id={q.id} onToggle={e => { if (e.currentTarget.open) e.currentTarget.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), button:not(:disabled)')?.focus(); }} onKeyDown={e => { if (e.key === 'Escape' && !(e.nativeEvent.isComposing || e.keyCode === 229)) { e.stopPropagation(); e.preventDefault(); close(); } }}>
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
      {draft.unknownKey && <div role="status"><p>正在确认原答复的接收结果，请勿重复提交。</p><button className="button" disabled={busy || client.read().connection !== 'live'} onClick={() => void check()}>核查原答复</button></div>}
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}
