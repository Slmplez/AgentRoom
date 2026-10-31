import React from 'react';
import type { z } from 'zod';
import type { curationStatusSchema, curationHistorySchema } from '../../contracts/memory-curation-view.mjs';
import { CURATION_LIMITS } from '../../contracts/memory-curation.mjs';
import './memory-curation-section.css';

export type CurationStatus = z.infer<typeof curationStatusSchema>;
export type CurationHistory = z.infer<typeof curationHistorySchema>;
type Props = {
  scopeLabel: string; status: CurationStatus | null; history: CurationHistory | null;
  busy: boolean; error?: string; modelLabel?: string; onRefresh(): void;
  onConfigure(enabled: boolean, expectedRevision: number): void;
  onInspect(runId: string): void; onHistory(before?: number): void;
  onSource?(memoryId: string, revision: number): void;
};
const statusText = { running: '正在整理', applied: '已应用', stale: '原记录已更新，本轮未应用', failed: '整理未通过校验', unknown: '结果待核查' };
const date = (value: number) => new Date(value).toLocaleString();

// Presentation only. The future Settings/Client controller owns authenticated
// reads, idempotency keys, pending operations and scope changes. Mount with a
// backend/database/owner/scope key; never carry history between identities.
export function MemoryCurationSection({ scopeLabel, status, history, busy, error, modelLabel, onRefresh, onConfigure, onInspect, onHistory, onSource }: Props) {
  const latest = status?.latestRun;
  return <section className="memory-curation-section" aria-label={`${scopeLabel}的自动记忆整理`}>
    <header><div><h3>自动整理记忆</h3><p>后台 Agent 为{scopeLabel}合并重复记忆、更新结论并归档过时内容，保留依据和历史。</p></div><button type="button" className="button" disabled={busy} onClick={onRefresh}>刷新整理状态</button></header>
    {error && <p role="alert">{error}</p>}
    {!status ? <p role="status">正在读取整理状态…</p> : <>
      {!status.configured ? <p role="status">尚未配置后台整理 Agent。已保存的记忆仍保留，当前不会自动整理。</p> : <>
        <div className="memory-curation-controls"><span>{status.enabled ? '自动整理已启用' : '自动整理已暂停'}{modelLabel ? ` · ${modelLabel}` : ''}</span><button type="button" className="button" disabled={busy || (!status.enabled && Boolean(latest?.leaseHeld))} onClick={() => onConfigure(!status.enabled, status.revision)}>{status.enabled ? '暂停自动整理' : '启用自动整理'}</button></div>
        <p className="settings-note">至少间隔 10 分钟，每 24 小时最多 {CURATION_LIMITS.startsPerDay} 轮；没有新记录时不调用模型。Soul 独立保存，整理不会改写个性。</p>
      </>}
      <p>{status.summaries.length} 条有效摘要 · {status.pending} 条待整理{status.stale > 0 ? ` · ${status.stale} 条旧摘要已因来源变化退出加载` : ''}</p>
      {latest && <div className="memory-curation-run" role="status"><strong>{statusText[latest.status]}</strong><p>{latest.note}</p><small>{date(latest.startedAt)}{latest.finishedAt !== null ? ` → ${date(latest.finishedAt)}` : ''}</small>
        {latest.status !== 'running' && Boolean(latest.leaseHeld) && <><p>原进程尚未确认结束，后台整理暂不启动下一轮。</p><button type="button" className="button" disabled={busy} onClick={() => onInspect(latest.id)}>核查原整理进程</button></>}
        {status.configured && status.enabled && !latest.leaseHeld && ['failed', 'unknown'].includes(latest.status) && <><p>原结果不会自动重试。可以使用当前记录启动新一轮整理。</p><button type="button" className="button" disabled={busy} onClick={() => onConfigure(true, status.revision)}>允许重新整理当前记录</button></>}
      </div>}
      <div className="memory-curation-summaries">{status.summaries.map(item => <article key={item.id}><p>{item.text}</p><details><summary>整理依据与来源</summary><p>{item.reason}</p><ul>{item.refs.map(ref => <li key={ref.id}>{onSource ? <button type="button" className="button" disabled={busy} onClick={() => onSource(ref.id, ref.revision)}>来源 {ref.id} · v{ref.revision}</button> : <span>{ref.id} · v{ref.revision}</span>}</li>)}</ul><small>整理批次 {item.runId}</small></details></article>)}</div>
      {status.summaries.length === 0 && <p className="settings-note">尚无有效整理摘要。待整理的原始记录仍按任务上下文预算加载。</p>}
      <details className="memory-curation-history" onToggle={event => { if (event.currentTarget.open && history === null && !busy) onHistory(); }}><summary>整理历史</summary>
        {history === null ? <p>展开后读取历史。</p> : <>
          {history.runs.length === 0 && <p>暂无整理记录。</p>}
          {history.runs.map(run => <article key={run.id}><strong>{statusText[run.status]}</strong><p>{date(run.startedAt)} · {run.input.executor.agentId} · {run.input.executor.model}</p><p>{run.note}</p>
            {run.output?.summaries.map((item, index) => <div className="memory-curation-change" key={`summary:${index}`}><strong>整理后的结论</strong><p>{item.text}</p><p>依据：{item.reason}</p><p>输入：{item.inputs.join('、')}</p></div>)}
            {run.output?.archives.map((item, index) => <div className="memory-curation-change" key={`archive:${index}`}><strong>归档</strong><p>{item.reason}</p><ul>{item.inputs.map(key => <li key={key}>{run.input.inputs.find(source => source.key === key)?.text || key}</li>)}</ul></div>)}
            <details><summary>本轮输入与版本</summary>{run.input.inputs.map(input => <div key={input.key}><p>{input.text}</p><small>{input.key}</small><ul>{input.refs.map(ref => <li key={ref.id}>{ref.id} · v{ref.revision}</li>)}</ul></div>)}</details>
          </article>)}
        </>}
        <button type="button" className="button" disabled={busy || Boolean(history && history.before === null)} onClick={() => onHistory(history?.before ?? undefined)}>{history ? '更早整理记录' : '读取整理历史'}</button>
      </details>
    </>}
  </section>;
}
