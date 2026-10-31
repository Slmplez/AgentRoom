import React, { useEffect, useRef, useState } from 'react';
import { sameMemoryScope } from '../../contracts/agent-memory.mjs';
import { curationStatusSchema, curationHistorySchema } from '../../contracts/memory-curation-view.mjs';
import { MemoryCurationSection, type CurationStatus, type CurationHistory } from './memory-curation-section';

type Scope = { kind: 'agent'; agentId: string } | { kind: 'room'; roomId: string };
type Query = { workspaceId: string; scope: Scope };
type Pending = { key: string; outcome: 'unknown' | 'not_found' };
// Implement this Adapter through the existing authenticated Client once its
// shared entry points are handed over. Writes MUST journal before dispatch;
// check/retry MUST use the original saved command, not a reconstructed payload.
export type MemoryCurationBridge = {
  status(input: Query): Promise<unknown>;
  history(input: Query & { before?: number; limit: number }): Promise<unknown>;
  configure(input: Query & { enabled: boolean; expectedRevision: number; key: string }): Promise<{ accepted: boolean }>;
  inspect(input: Query & { runId: string; key: string }): Promise<{ accepted: boolean }>;
  pending(input: Query): Pending[];
  subscribe(listener: () => void): () => void;
  check(key: string): Promise<{ accepted: boolean } | null>;
  retry(key: string): Promise<{ accepted: boolean }>;
};

export function MemoryCurationController({ bridge, workspaceId, scope, scopeLabel, live, onSource }: {
  bridge: MemoryCurationBridge; workspaceId: string; scope: Scope; scopeLabel: string; live: boolean;
  onSource(memoryId: string, revision: number): void;
}) {
  const [status, setStatus] = useState<CurationStatus | null>(null), [history, setHistory] = useState<CurationHistory | null>(null);
  const [pending, setPending] = useState<Pending[]>([]), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false), [journalUnavailable, setJournalUnavailable] = useState(false);
  const active = useRef(false), generation = useRef(0), readVersion = useRef(0);
  const lock = useRef<{ generation: number } | null>(null), historyLock = useRef<{ generation: number } | null>(null);
  const identity = JSON.stringify([workspaceId, scope]);
  const message = (e: unknown) => e instanceof Error ? e.message : '无法完成操作，请核查原请求。';
  function syncPending() {
    if (!active.current) return;
    try { setPending(bridge.pending({ workspaceId, scope })); setJournalUnavailable(false); }
    catch { setJournalUnavailable(true); setError('原请求日志不可读取，提交已停止。请恢复日志后刷新核查。'); }
  }
  async function refresh() {
    const started = generation.current, version = ++readVersion.current;
    try {
      const next = curationStatusSchema.parse(await bridge.status({ workspaceId, scope }));
      if (active.current && started === generation.current && version === readVersion.current) setStatus(next);
    } catch (e) { if (active.current && started === generation.current && version === readVersion.current) setError(message(e)); }
  }
  useEffect(() => {
    active.current = true; generation.current++; setBusy(false); setStatus(null); setHistory(null); setError(''); setNotice(''); syncPending();
    const unsubscribe = bridge.subscribe(syncPending);
    if (live) void refresh();
    return () => { active.current = false; generation.current++; unsubscribe(); };
  }, [bridge, identity, live]);
  async function act(action: () => Promise<{ accepted: boolean } | null>, recovery = false) {
    if (!live || lock.current?.generation === generation.current || journalUnavailable) return;
    try { if (!recovery && bridge.pending({ workspaceId, scope }).length) { syncPending(); return; } }
    catch { setJournalUnavailable(true); setError('原请求日志不可读取，提交已停止。请恢复日志后刷新核查。'); return; }
    const token = { generation: generation.current }; lock.current = token;
    setBusy(true); setError(''); setNotice(''); const started = generation.current;
    try {
      const receipt = await action();
      if (receipt !== null && receipt.accepted !== true) throw Error('请求回执不可确认，请核查原请求。');
      if (active.current && started === generation.current) {
        setNotice(receipt ? '操作已确认，正在读取当前状态。' : '尚未找到原请求；可使用已保存的原请求明确重试。');
        setHistory(null); await refresh();
      }
    } catch (e) { if (active.current && started === generation.current) setError(message(e)); }
    finally { if (lock.current === token) lock.current = null; if (active.current && started === generation.current) { setBusy(false); syncPending(); } }
  }
  async function readHistory(before?: number) {
    if (!live || historyLock.current?.generation === generation.current) return;
    const token = { generation: generation.current }; historyLock.current = token; const started = generation.current;
    try {
      const page = curationHistorySchema.parse(await bridge.history({ workspaceId, scope, before, limit: 10 }));
      if (page.runs.some(run => !sameMemoryScope(run.input.scope, scope))) throw Error('整理历史归属不匹配。');
      if (active.current && started === generation.current) setHistory(old => ({ before: page.before, runs: before && old ? [...new Map([...old.runs, ...page.runs].map(run => [run.id, run])).values()] : page.runs }));
    } catch (e) { if (active.current && started === generation.current) setError(message(e)); }
    finally { if (historyLock.current === token) historyLock.current = null; }
  }
  return <div>
    {!live && <p role="status">连接恢复后可读取后台整理状态。</p>}
    {notice && <p role="status">{notice}</p>}
    {pending.map(operation => <div role="status" key={operation.key}><p>整理设置或核查请求结果待确认，不会自动重发。</p><button className="button" disabled={!live || busy || journalUnavailable} onClick={() => void act(() => bridge.check(operation.key), true)}>核查原整理请求</button>{operation.outcome === 'not_found' && <button className="button" disabled={!live || busy || journalUnavailable} onClick={() => void act(() => bridge.retry(operation.key), true)}>重试保存的原整理请求</button>}</div>)}
    <MemoryCurationSection scopeLabel={scopeLabel} status={status} history={history} busy={!live || busy} mutationsDisabled={journalUnavailable || pending.length > 0} error={error}
      onRefresh={() => { if (live) { setError(''); syncPending(); setHistory(null); void refresh(); } }}
      onConfigure={(enabled, expectedRevision) => void act(() => bridge.configure({ workspaceId, scope, enabled, expectedRevision, key: crypto.randomUUID() }))}
      onInspect={runId => void act(() => bridge.inspect({ workspaceId, scope, runId, key: crypto.randomUUID() }))}
      onHistory={before => void readHistory(before)} onSource={onSource} />
  </div>;
}
