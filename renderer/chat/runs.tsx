import React, { useState } from 'react';
import type { ChatClient, Snapshot } from './types';

const labels: Record<string, string> = { queued: '排队中', running: '执行中', cancel_requested: '等待停止确认', complete: '执行结束', cancelled: '已确认停止', failed: '执行失败', unknown: '执行结果未确认' };
export function RunPanel({ client, state, roomId }: { client: ChatClient; state: Snapshot; roomId?: string }) {
  const [error, setError] = useState('');
  const runs = state.runs.filter(r => r.roomId === roomId && r.status !== 'complete');
  if (!runs.length && !error) return null;
  return <div className="chat-runs" aria-label="执行状态">{runs.map(run => <div key={run.id} data-run-id={run.id}>
    <span>{state.agents.find(a => a.id === run.agentId)?.displayName} · {labels[run.status]}{run.queuePosition ? ` · 第 ${run.queuePosition} 位` : ''}</span>
    {run.canCancel && <button className="button" disabled={state.connection !== 'live'} onClick={async () => {
      try { setError(''); await client.dispatch({ type: 'cancelRun', key: crypto.randomUUID(), runId: run.id }); }
      catch (e) { setError((e as Error).message); }
    }}>取消执行</button>}{run.error && <span role="status">{run.error}</span>}
  </div>)}{error && <p role="alert">{error}</p>}</div>;
}
