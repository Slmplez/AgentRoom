import React, { useEffect, useRef, useState } from 'react';
import type { ChatClient, Snapshot } from './types';
import './local-tasks.css';
import { TaskMemoryContext } from './memory-panel';
const labels: Record<string, string> = { queued: '已记录，等待派发', dispatching: '正在启动', running: '执行中', awaiting_input: '需要你回答', answer_pending: '答复已记录，等待投递', submitting: '正在投递答复', reviewing: '执行已结束，待验收', failed: '执行失败', unknown: '执行结果未知，需核查', paused: '已暂停，未自动启动' };
type Draft = { revision: number; optionIds: string[]; text: string };
type LocalDrafts = { goal: string; answers: Record<string, Draft> };
function saved(key: string): LocalDrafts {
  try {
    const value = JSON.parse(localStorage.getItem(key) || 'null');
    if (!value || typeof value.goal !== 'string' || !value.answers || typeof value.answers !== 'object') return { goal: '', answers: {} };
    const answers: Record<string, Draft> = {};
    for (const [id, raw] of Object.entries(value.answers).slice(-100)) {
      const d = raw as Partial<Draft> | null;
      if (d && Number.isInteger(d.revision) && typeof d.text === 'string' && Array.isArray(d.optionIds) && d.optionIds.every(id => typeof id === 'string')) answers[id] = { revision: d.revision!, text: d.text.slice(0, 4000), optionIds: d.optionIds.slice(0, 20) };
    }
    return { goal: value.goal.slice(0, 16000), answers };
  } catch { return { goal: '', answers: {} }; }
}
export function LocalTasks({ client, state, roomId, onConsult }: { client: ChatClient; state: Snapshot; roomId: string; onConsult?(task: Snapshot['localTasks'][number]): void }) {
  const storageKey = `ar-local-tasks:${JSON.stringify([state.backendId, state.databaseId, state.currentUserId, roomId])}`;
  const [drafts, setDrafts] = useState(() => saved(storageKey)), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const lock = useRef(false), panel = useRef<HTMLDetailsElement>(null);
  const tasks = state.localTasks.filter(t => t.roomId === roomId);
  const operations = (state.pendingOperations || []).filter(p => p.type === 'createLocalTask' || p.type === 'answerLocalQuestion');
  const live = state.connection === 'live', enabled = state.capabilities.localExecution && live;
  const active = tasks.some(t => t.leaseHeld || ['queued', 'dispatching', 'running', 'awaiting_input', 'answer_pending', 'submitting', 'unknown'].includes(t.phase));
  useEffect(() => { if (state.backendId && state.databaseId && state.currentUserId) { try { localStorage.setItem(storageKey, JSON.stringify(drafts)); } catch { /* Command journal still rejects writes when storage is unavailable. */ } } }, [storageKey, drafts]);
  if (!state.capabilities.localExecution && !tasks.length) return null;
  async function act(action: () => Promise<unknown>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await action(); } catch (e) { setError((e as Error).message); }
    finally { lock.current = false; setBusy(false); }
  }
  return <details ref={panel} className="local-tasks" open><summary>本机只读任务 · {tasks.length}{tasks.some(t => t.phase === 'awaiting_input') ? ' · 有问题需要回答' : ''}</summary>
    <div className="local-tasks-body">
      {state.capabilities.localExecution && <details className="local-new-task" open={!tasks.length}><summary>发起只读任务</summary><form onSubmit={e => { e.preventDefault(); if (!enabled || busy || active || operations.length || !drafts.goal.trim()) return; const goal = drafts.goal; void act(async () => { await client.dispatch({ type: 'createLocalTask', key: crypto.randomUUID(), workspaceId: state.rooms.find(r => r.id === roomId)!.workspaceId, roomId, ownerAgentId: state.localAgentId!, goal }); setDrafts(old => old.goal === goal ? { ...old, goal: '' } : old); }); }}>
        <label>交给本机 Pi 的目标<textarea aria-label="本机任务目标" maxLength={16000} rows={2} value={drafts.goal} onChange={e => setDrafts(old => ({ ...old, goal: e.target.value }))} /></label>
        <p className="local-task-note">负责人：{state.localAgentId} · {state.capabilities.artifactPublishing ? '只读工作目录，可发布任务报告' : '仅只读工具'}。普通聊天不会启动执行。</p>
        <button className="button" data-create-local-task type="submit" disabled={!enabled || busy || active || operations.length > 0 || !drafts.goal.trim()}>启动只读任务</button>
      </form></details>}
      {operations.map(o => <div key={o.key} className="local-task-notice" role="status">原任务请求结果待核查。
        <button className="button" data-check-local-operation disabled={!live || busy} onClick={() => void act(async () => { const result = await client.checkOperation?.(o.key); if (!result) setError('原请求尚未找到，可显式重试保存的原请求。'); })}>核查原任务请求</button>
        {o.outcome === 'not_found' && <button className="button" disabled={!enabled || busy} onClick={() => void act(async () => { await client.retryOperation?.(o.key); })}>重试保存的原请求</button>}
      </div>)}
      {tasks.map(task => { const q = task.question, draft = q && (drafts.answers[q.id] || { revision: q.revision, optionIds: [], text: '' });
        const blocked = !enabled || busy || operations.some(o => o.type === 'createLocalTask' || o.taskId === task.id) || task.phase !== 'awaiting_input' || q?.status !== 'pending' || draft?.revision !== q?.revision;
        const update = (value: Draft) => q && setDrafts(old => ({ ...old, answers: { ...old.answers, [q.id]: value } }));
        return <article key={task.id} data-local-task={task.id}>
          <header><strong>{task.goal}</strong><span role="status" data-local-phase={task.phase}>{labels[task.phase]}</span></header>
          <p className="local-task-note">负责人：{task.ownerAgentId}</p><details className="local-task-note"><summary>执行标识</summary><code>{task.runId}</code></details>
          {task.formWait && <p className="local-task-note">表单：{task.formWait.title} · 版本 {task.formWait.version}。请从消息中的表单入口填写，保存答复后再明确继续。</p>}
          {q && draft && <details className="local-native-question" open={q.status === 'pending'}><summary>{q.status === 'pending' ? '需要你回答' : q.status === 'answered' ? '已记录答复' : '原问题已失效'} · {q.title}</summary>
            {q.response ? <p>{[...q.response.optionIds.map(id => q.options.find(o => o.id === id)?.label), q.response.text].filter(Boolean).join('，')}</p> : <form onSubmit={e => { e.preventDefault(); if (blocked || (!draft.optionIds.length && !draft.text.trim())) return; void act(async () => { await client.dispatch({ type: 'answerLocalQuestion', key: crypto.randomUUID(), workspaceId: state.rooms.find(r => r.id === roomId)!.workspaceId, roomId, taskId: task.id, questionId: q.id, expectedRevision: draft.revision, optionIds: draft.optionIds, text: draft.text }); }); }}>
              <fieldset disabled={blocked}><legend>答复内容</legend>{q.options.map(o => <label key={o.id}><input type={q.multiple ? 'checkbox' : 'radio'} name={q.id} value={o.id} checked={draft.optionIds.includes(o.id)} onChange={e => update({ ...draft, optionIds: q.multiple ? e.target.checked ? [...draft.optionIds, o.id] : draft.optionIds.filter(id => id !== o.id) : [o.id] })} />{o.label}</label>)}
              {draft.optionIds.length > 0 && <button className="button" type="button" onClick={() => update({ ...draft, optionIds: [] })}>清除选择</button>}
              <label>你的答复<textarea aria-label="真实问题答复" value={draft.text} rows={2} maxLength={4000} onChange={e => update({ ...draft, text: e.target.value })} /></label></fieldset>
              {state.capabilities.consultations && <button type="button" className="button" data-consult-native-question disabled={blocked} onClick={() => onConsult?.(task)}>请 Agent 提供建议</button>}
              <button data-answer-local-question className="button" type="submit" disabled={blocked || (!draft.optionIds.length && !draft.text.trim())}>提交答复</button>
            </form>}
            {q.status === 'expired' && <p role="status">原引擎输入会话不可恢复，草稿已保留，不能再次投递。</p>}
          </details>}
          {task.history.length > 0 && <details><summary>已处理的问题 · {task.history.length}</summary>{task.history.map(item => <p key={item.id}><strong>{item.title}</strong> · {item.response ? [...item.response.optionIds.map(id => item.options.find(o => o.id === id)?.label), item.response.text].filter(Boolean).join('，') : '未答复，原请求已失效'}</p>)}</details>}
          {task.delivery !== 'none' && <p className="local-task-note">答复投递：{({ pending: '已记录，等待提交', attempting: '正在提交，结果尚未确认', submitted: '已提交到原引擎管道', unknown: '结果未知，不会自动重发' })[task.delivery]}</p>}
          {state.capabilities.agentMemory && <TaskMemoryContext client={client} roomId={roomId} taskId={task.id} />}
          {task.result && <pre className="local-task-result">{task.result}</pre>}
          {task.leaseHeld && task.phase === 'reviewing' && <p className="local-task-note">正在确认原引擎进程结束，执行槽尚未释放。</p>}
          {task.phase === 'reviewing' && <p className="local-task-note">轮次结束，尚未通过任务验收。</p>}
        </article>;
      })}
      {error && <p role="alert">{error}</p>}
    </div>
  </details>;
}
