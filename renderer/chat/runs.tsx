import React, { useState } from 'react';
import type { ChatClient, Snapshot } from './types';

const labels: Record<string, string> = { queued: '排队中', running: '执行中', cancel_requested: '等待停止确认', complete: '执行结束', cancelled: '已确认停止', failed: '执行失败', unknown: '执行结果未确认' };
export function RunPanel({ client, state, roomId }: { client: ChatClient; state: Snapshot; roomId?: string }) {
  const [error, setError] = useState('');
  const runs = state.runs.filter(r => r.roomId === roomId && r.status !== 'complete');
  const group = state.rooms.find(r => r.id === roomId)?.type === 'group';
  const running = runs.filter(r => r.status === 'running').length;
  const queued = runs.filter(r => r.status === 'queued').length;
  const attention = runs.filter(r => ['failed', 'unknown', 'cancel_requested'].includes(r.status)).length;
  if (!runs.length && !error) return null;
  const contents = <>{runs.map(run => <div key={run.id} data-run-id={run.id}>
    <span>{state.agents.find(a => a.id === run.agentId)?.displayName} · {labels[run.status]}{run.queuePosition ? ` · 第 ${run.queuePosition} 位` : ''}</span>
    {run.canCancel && <button className="button" disabled={state.connection !== 'live'} onClick={async () => {
      try { setError(''); await client.dispatch({ type: 'cancelRun', key: crypto.randomUUID(), runId: run.id }); }
      catch (e) { setError((e as Error).message); }
    }} aria-label={`停止 ${state.agents.find(a => a.id === run.agentId)?.displayName || 'Agent'} 的本次执行`}>取消执行</button>}{run.error && <span role="status">{run.error}</span>}
  </div>)}</>;
  return <div className="chat-runs" aria-label="执行状态">{group ? <details className="run-summary"><summary>{[running ? `${running} 项执行中` : '', queued ? `${queued} 项排队中` : '', attention ? `${attention} 项需要核查` : '', !running && !queued && !attention ? '执行已停止' : ''].filter(Boolean).join(' · ')}<span>查看执行</span></summary>{contents}</details> : contents}{error && <p role="alert">{error}</p>}</div>;
}
