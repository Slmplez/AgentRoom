import React, { useEffect, useRef, useState } from 'react';
import type { ChatClient, Command, QueryResult, Snapshot } from './types';
import { sameMemoryScope, MEMORY_LIMITS } from '../../contracts/agent-memory.mjs';
import { MemoryCurationController, type MemoryCurationBridge } from './memory-curation-controller';
import './memory-panel.css';

export type MemoryScope = { kind: 'agent'; agentId: string } | { kind: 'room'; roomId: string };
type Memory = QueryResult<'explicitMemories'>['memories'][number];
type Soul = QueryResult<'agentSoul'>;
type Values = { text: string } | { personality: string; expression: string; workStyle: string };
type MemoryCommand = Extract<Command, { type: 'editAgentSoul' | 'saveExplicitMemory' | 'correctExplicitMemory' | 'forgetExplicitMemory' }>;
type Draft = { revision: number; values: Values; submitted?: MemoryCommand };
const count = (values: Values) => Object.values(values).reduce((n, text) => n + [...text].length, 0);
function readSelection(key: string) { try { return localStorage.getItem(key) || ''; } catch { return ''; } }
const errorText = (e: unknown) => e instanceof Error ? e.message : '操作失败，请重新读取。';

// Local UI drafts only; the server and Client remain the sole authority for saved state.
function readDraft(prefix: string, initial: Draft): Draft {
  try {
    const revision = localStorage.getItem(prefix + ':latest');
    const raw = JSON.parse(localStorage.getItem(prefix + ':' + revision) || 'null');
    if (raw && Number.isSafeInteger(raw.revision) && raw.revision >= 0 && raw.values && Object.keys(initial.values).every(k => typeof raw.values[k] === 'string') && Object.keys(raw.values).length === Object.keys(initial.values).length && (!raw.submitted || typeof raw.submitted.key === 'string')) return raw;
  } catch { /* A malformed draft is never submitted. */ }
  return initial;
}
function Editor({ client, prefix, revision, initial, label, soul = false, disabled, refresh, command }: {
  client: ChatClient; prefix: string; revision: number; initial: Values; label: string; soul?: boolean; disabled: boolean; refresh(): Promise<void>;
  command(draft: Draft, key: string): MemoryCommand;
}) {
  const [draft, setDraft] = useState(() => readDraft(prefix, { revision, values: initial }));
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [missing, setMissing] = useState(false);
  const lock = useRef(false), mounted = useRef(true), max = soul ? MEMORY_LIMITS.soul : MEMORY_LIMITS.text;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const persist = (next: Draft) => {
    localStorage.setItem(prefix + ':' + next.revision, JSON.stringify(next));
    localStorage.setItem(prefix + ':latest', String(next.revision));
    setDraft(next);
  };
  const clear = () => { localStorage.removeItem(prefix + ':' + draft.revision); localStorage.removeItem(prefix + ':latest'); };
  async function run(action: () => Promise<void>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await action(); } catch (e) { if (mounted.current) setError(errorText(e)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  async function confirmed() {
    clear();
    if (mounted.current) setDraft({ revision, values: initial });
    await refresh();
  }
  async function check() {
    if (!draft.submitted) return;
    const receipt = await client.checkOperation?.(draft.submitted.key, draft.submitted.type);
    if (receipt) await confirmed(); else { setMissing(true); setError('尚未找到原请求。可明确重试原内容，原请求标识保持不变。'); }
  }
  async function submit(submitted: MemoryCommand) {
    try { await client.dispatch(submitted); }
    catch (e) { if ((e as { outcome?: string }).outcome !== 'unknown') { persist({ ...draft, submitted: undefined }); setMissing(false); } throw e; }
    await confirmed();
  }
  // Reload/reconnect only checks receipts; it never resubmits a draft.
  useEffect(() => { if (draft.submitted && !disabled) void run(check); }, [disabled]);
  const stale = draft.revision !== revision;
  const blocked = disabled || busy || stale || Boolean(draft.submitted) || count(draft.values) > max || (!soul && !('text' in draft.values && draft.values.text.trim()));
  function update(field: string, value: string) {
    try { persist({ ...draft, values: { ...draft.values, [field]: value } }); setError(''); }
    catch { setError('无法保存本地草稿，提交已停止。请检查浏览器存储。'); }
  }
  return <form className="memory-editor" onSubmit={e => {
    e.preventDefault(); if (blocked) return;
    void run(async () => {
      const submitted = command(draft, crypto.randomUUID());
      persist({ ...draft, submitted });
      await submit(submitted);
    });
  }}>
    {Object.entries(draft.values).map(([field, text]) => <label key={field}>{({ personality: '个性', expression: '表达方式', workStyle: '工作方式', text: label })[field]}
      <textarea aria-label={field === 'text' ? label : ({ personality: '个性', expression: '表达方式', workStyle: '工作方式' })[field]} rows={soul ? 2 : 3} value={text} disabled={busy || Boolean(draft.submitted)} onChange={e => update(field, e.target.value)} />
    </label>)}
    <p className="settings-note">{count(draft.values)} / {max} 字符{count(draft.values) > max ? ' · 超出上限，请手动精简。' : ''} · 草稿基于版本 {draft.revision}</p>
    {stale && <div role="status"><p>当前已是版本 {revision}，旧草稿已保留。请比较当前内容后明确选择：</p><button type="button" className="button" disabled={busy || Boolean(draft.submitted)} onClick={() => { try { persist({ revision, values: draft.values }); } catch (e) { setError(errorText(e)); } }}>以当前版本继续编辑这份草稿</button><button type="button" className="button" disabled={busy || Boolean(draft.submitted)} onClick={() => { try { persist({ revision, values: initial }); } catch (e) { setError(errorText(e)); } }}>使用当前内容</button></div>}
    {draft.submitted && <div role="status"><p>原请求结果待核查，草稿和请求标识已保留。</p><button type="button" className="button" disabled={disabled || busy} onClick={() => void run(check)}>核查这份草稿的原请求</button>{missing && <button type="button" className="button" disabled={disabled || busy} onClick={() => void run(() => submit(draft.submitted!))}>重试这份原请求</button>}</div>}
    <button type="submit" className="button" disabled={blocked}>{soul ? '保存 Soul' : label === '新记忆' ? '保存明确记忆' : '保存更正'}</button>
    {error && <p role="alert">{error} 使用面板的“刷新当前状态”读取最新版本，草稿不会被覆盖。</p>}
  </form>;
}

function History({ client, workspaceId, scope, memoryId }: { client: ChatClient; workspaceId: string; scope: MemoryScope; memoryId?: string }) {
  const [pages, setPages] = useState<(QueryResult<'explicitMemoryHistory'> | QueryResult<'agentSoulHistory'>)[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const lock = useRef(false), alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  async function load() {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try {
      const beforeRevision = pages.at(-1)?.beforeRevision ?? undefined;
      const page = memoryId ? await client.query({ type: 'explicitMemoryHistory', workspaceId, scope, memoryId, limit: 10, beforeRevision }) : await client.query({ type: 'agentSoulHistory', workspaceId, agentId: scope.kind === 'agent' ? scope.agentId : '', limit: 10, beforeRevision });
      if (alive.current) setPages(old => [...old, page]);
    } catch (e) { if (alive.current) setError(errorText(e)); } finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  return <details className="memory-history" onToggle={e => { if (e.currentTarget.open && !pages.length && !lock.current) void load(); }}><summary>来源与版本历史</summary>
    {pages.map((page, i) => <div key={i}>{'current' in page && <p>读取时状态：{page.current.status === 'active' ? '有效' : '已停用'} · v{page.current.revision}</p>}
      {page.revisions.map(r => <article key={r.revision}><strong>v{r.revision}</strong> · {r.createdAt} · {r.authorId}{'status' in r && ` · ${r.status === 'active' ? '有效' : '已停用'}`}<pre>{'text' in r ? r.text : JSON.stringify({ personality: r.personality, expression: r.expression, workStyle: r.workStyle }, null, 2)}</pre>{'sourceIds' in r && <p>来源：{r.sourceIds.join('、')}</p>}</article>)}
      {'sources' in page && page.sources.map(s => <article key={s.id}><strong>{s.kind === 'message' ? '讨论消息原文' : '手动记录原文'}</strong><p>{s.id} · {s.authorId} · {s.occurredAt}</p>{s.messageId && <p>Room {s.roomId} / 消息 {s.messageId} / v{s.messageRevision}</p>}<pre>{s.text}</pre></article>)}
      {!page.revisions.length && <p>暂无历史。</p>}
    </div>)}
    {(error || pages.at(-1)?.beforeRevision) && <button className="button" disabled={busy} onClick={() => void load()}>{error ? '重试读取历史' : '更早版本'}</button>}{busy && <p role="status">正在读取…</p>}{error && <p role="alert">{error}</p>}
  </details>;
}

export function MemorySettings({ client, state, roomId, curation }: { client: ChatClient; state: Snapshot; roomId: string; curation?: MemoryCurationBridge }) {
  const [scope, setScope] = useState<MemoryScope>({ kind: 'room', roomId });
  const identity = JSON.stringify([state.backendId, state.databaseId, state.currentUserId, state.rooms.find(r => r.id === roomId)?.workspaceId, scope]);
  return <div className="memory-settings">
    <h3>Soul 与明确记忆</h3>
    <label>管理归属<select aria-label="记忆归属" value={scope.kind === 'room' ? 'room' : scope.agentId} onChange={e => setScope(e.target.value === 'room' ? { kind: 'room', roomId } : { kind: 'agent', agentId: e.target.value })}><option value="room">当前 Room · {state.rooms.find(r => r.id === roomId)?.title}</option>{state.knownAgents.map(id => <option key={id} value={id}>Agent · {id}</option>)}</select></label>
    <p className="settings-note">每个 Agent 保留独立个性。原始记录持续保存，任务启动时按上下文预算加载自己的 Soul 和有效的个人、Room 记忆。</p>
    <MemoryScopePanel key={identity} client={client} state={state} scope={scope} prefix={'ar-memory-draft:' + identity} curation={curation} />
  </div>;
}
function MemoryScopePanel({ client, state, scope, prefix, curation }: { client: ChatClient; state: Snapshot; scope: MemoryScope; prefix: string; curation?: MemoryCurationBridge }) {
  const workspaceId = state.workspaces[0]?.id || '';
  const [soul, setSoul] = useState<Soul | null>(null), [memories, setMemories] = useState<Memory[]>([]), [ready, setReady] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [version, setVersion] = useState(0), [editing, setEditing] = useState<string | null>(null), [confirm, setConfirm] = useState<string | null>(null), [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState(() => readSelection(prefix + ':history')), [messageId, setMessageId] = useState('');
  const [total, setTotal] = useState(0), [afterId, setAfterId] = useState<string | null>(null), [pageBusy, setPageBusy] = useState(false);
  const pageLock = useRef(false), refreshing = useRef(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const request = useRef(0), alive = useRef(true), lock = useRef(false);
  const pending = (state.pendingOperations || []).filter(o => sameMemoryScope(o.memoryScope, scope));
  const live = state.connection === 'live' && state.capabilities.agentMemory;
  const disabled = !live || busy || pending.length > 0;
  async function refresh() {
    const n = ++request.current; refreshing.current = true; setRefreshBusy(true); setError('');
    try {
      const [list, profile] = await Promise.all([client.query({ type: 'explicitMemories', workspaceId, scope }), scope.kind === 'agent' ? client.query({ type: 'agentSoul', workspaceId, agentId: scope.agentId }) : Promise.resolve(null)]);
      if (alive.current && n === request.current) { setMemories(list.memories); setTotal(list.total); setAfterId(list.afterId); setSoul(profile); setConfirm(null); setReady(true); setVersion(v => v + 1); }
    } catch (e) { if (alive.current && n === request.current) { setError(errorText(e)); throw e; } }
    finally { if (alive.current && n === request.current) { refreshing.current = false; setRefreshBusy(false); } }
  }
  useEffect(() => { alive.current = true; if (live) void refresh().catch(() => {}); return () => { alive.current = false; ++request.current; }; }, [live]);
  async function more() {
    if (!afterId || refreshing.current || pageLock.current || disabled) return;
    const generation = request.current; pageLock.current = true; setPageBusy(true); setError('');
    try {
      const page = await client.query({ type: 'explicitMemories', workspaceId, scope, afterId });
      if (alive.current && generation === request.current) {
        setMemories(old => [...new Map([...old, ...page.memories].map(item => [item.id, item])).values()]);
        setAfterId(page.afterId); setTotal(page.total);
      }
    } catch (e) { if (alive.current && generation === request.current) setError(errorText(e)); }
    finally { pageLock.current = false; if (alive.current) setPageBusy(false); }
  }
  async function act(action: () => Promise<unknown>) {
    if (lock.current) return; lock.current = true; setBusy(true); setError('');
    try { await action(); await refresh(); } catch (e) { if (alive.current) setError(errorText(e)); } finally { lock.current = false; if (alive.current) setBusy(false); }
  }
  const history = (id: string) => { setSelected(id); try { localStorage.setItem(prefix + ':history', id); } catch { /* Selection isn't authoritative. */ } };
  const messages = scope.kind === 'room' ? state.messages.filter(m => m.roomId === scope.roomId && m.role === 'user' && m.revision) : [];
  const source = messages.find(m => m.id === messageId);
  return <div className="memory-scope">
    {curation && <MemoryCurationController bridge={curation} workspaceId={workspaceId} scope={scope} scopeLabel={scope.kind === 'agent' ? scope.agentId : '当前 Room'} live={live} onSource={id => history(id)} />}
    <button className="button" disabled={!live || busy} onClick={() => void refresh().catch(() => {})}>刷新当前状态</button><p className="settings-note">进入面板、重新连接和本窗口保存后刷新；其他窗口的修改请手动刷新。停用仅影响之后启动的任务，来源历史和已启动任务的快照仍保留。</p>
    {!live && <p role="status">连接恢复后才能读取和保存。</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    {pending.map(o => <div key={o.key} role="status"><p>记忆请求结果待核查。</p><button className="button" disabled={!live || busy} onClick={() => void act(async () => { const receipt = await client.checkOperation?.(o.key, o.type); setNotice(receipt ? '原请求当时已提交；已重新读取当前状态。' : '原请求尚未找到，可明确重试原请求。'); })}>核查原记忆请求</button>{o.outcome === 'not_found' && <button className="button" disabled={!live || busy} onClick={() => void act(async () => { await client.retryOperation?.(o.key); })}>重试保存的原请求</button>}</div>)}
    {!ready ? <p role="status">等待读取当前配置…</p> : <>
      {soul && scope.kind === 'agent' && <section><h3>Soul · {soul.configured ? `v${soul.revision}` : '尚未配置'}</h3><details><summary>查看当前保存的个性</summary><pre>{JSON.stringify({ personality: soul.personality, expression: soul.expression, workStyle: soul.workStyle }, null, 2)}</pre></details>
        <Editor key={'soul:' + version} client={client} prefix={prefix + ':soul'} revision={soul.revision} initial={{ personality: soul.personality, expression: soul.expression, workStyle: soul.workStyle }} label="Soul" soul disabled={disabled} refresh={refresh} command={(d, key) => ({ type: 'editAgentSoul', workspaceId, agentId: scope.agentId, key, expectedRevision: d.revision, ...(d.values as { personality: string; expression: string; workStyle: string }) })} />
        <History key={'soul-history:' + version} client={client} workspaceId={workspaceId} scope={scope} />
      </section>}
      <section><h3>原始记忆记录 · {total}</h3><p className="settings-note">每条最多 {MEMORY_LIMITS.text} 个 Unicode 字符，不再限制为 16 条。原文、来源与历史持续保留；任务上下文单独控制加载量。</p>{!memories.length && <p>尚未保存明确记忆。</p>}
        {memories.map(m => <article className="memory-card" key={m.id} data-memory-id={m.id}><p>{m.text}</p><small>v{m.revision} · {scope.kind === 'agent' ? scope.agentId : '当前 Room'} · {m.sourceIds.length} 个来源</small><div className="memory-actions"><button className="button" onClick={() => history(m.id)}>查看来源与历史</button><button className="button" disabled={disabled} onClick={() => setEditing(editing === m.id ? null : m.id)}>更正记忆</button><button className="button" disabled={disabled} onClick={() => setConfirm(m.id)}>停用记忆</button></div>
          {editing === m.id && <Editor key={'edit:' + version} client={client} prefix={prefix + ':memory:' + m.id} revision={m.revision} initial={{ text: m.text }} label="更正内容" disabled={disabled} refresh={refresh} command={(d, key) => ({ type: 'correctExplicitMemory', workspaceId, scope, key, memoryId: m.id, expectedRevision: d.revision, text: (d.values as { text: string }).text })} />}
          {confirm === m.id && <div role="group" aria-label="确认停用"><p>停用后，后续启动任务不再加载这条记忆。历史和已启动快照仍保留。</p><button className="button" disabled={disabled} onClick={() => void act(async () => { await client.dispatch({ type: 'forgetExplicitMemory', workspaceId, scope, memoryId: m.id, expectedRevision: m.revision, key: crypto.randomUUID() }); history(m.id); setConfirm(null); setNotice('已停用。后续启动任务不再加载，历史仍可查看。'); })}>确认停用</button><button className="button" onClick={() => setConfirm(null)}>取消停用</button></div>}
        </article>)}
        {afterId && <button className="button" disabled={disabled || pageBusy || refreshBusy} onClick={() => void more()}>{pageBusy ? '正在读取更多记录…' : `加载更多记录（已显示 ${memories.length} / ${total}）`}</button>}
      </section>
      {selected && <section><h3>所选记忆的历史</h3><details><summary>记忆标识</summary><p>{selected}</p></details><History key={selected + ':' + version} client={client} workspaceId={workspaceId} scope={scope} memoryId={selected} /></section>}
      <section><h3>明确保存一条记忆</h3>{scope.kind === 'room' && <label>来源<select aria-label="记忆来源" value={messageId} onChange={e => setMessageId(e.target.value)}><option value="">手动记录</option>{messages.map(m => <option key={m.id} value={m.id}>消息 v{m.revision} · {m.text.slice(0, 60)}</option>)}</select></label>}{source && <details><summary>查看所选消息原文</summary><pre>{source.text}</pre><p>后端会核对同 Room 消息及版本，保存原文作为来源。</p></details>}
        <Editor key={'new:' + messageId + ':' + version} client={client} prefix={prefix + ':new:' + (source ? source.id + ':' + source.revision : 'owner-note')} revision={0} initial={{ text: '' }} label="新记忆" disabled={disabled || Boolean(messageId && !source)} refresh={refresh} command={(d, key) => ({ type: 'saveExplicitMemory', workspaceId, scope, key, text: (d.values as { text: string }).text, source: source ? { kind: 'message', messageId: source.id, revision: source.revision! } : { kind: 'owner-note' } })} />
      </section>
    </>}
  </div>;
}

function FrozenSources({ client, workspaceId, scope, refs }: { client: ChatClient; workspaceId: string; scope: MemoryScope; refs: { id: string; revision: number }[] }) {
  const [count, setCount] = useState(20);
  return <details><summary>来源版本与历史（{refs.length} 条）</summary>{refs.slice(0, count).map(ref => <div key={ref.id}><p>{ref.id} · 本次依据 v{ref.revision}</p><History client={client} workspaceId={workspaceId} scope={scope} memoryId={ref.id} /></div>)}{count < refs.length && <button className="button" onClick={() => setCount(n => n + 20)}>查看更多来源</button>}</details>;
}
function FrozenMemories({ client, workspaceId, snapshot }: { client: ChatClient; workspaceId: string; snapshot: Extract<QueryResult<'taskContextSnapshot'>, { status: 'available' }>['snapshot'] }) {
  if (snapshot.formatVersion === 1) return <>{snapshot.memories.map(m => <article key={m.id}><p>{m.scope.kind === 'agent' ? 'Agent' : 'Room'} · {m.id} · v{m.revision}</p><p>{m.text}</p><p>本次使用的来源：{m.sourceIds.join('、')}</p><History client={client} workspaceId={workspaceId} scope={m.scope} memoryId={m.id} /></article>)}{!snapshot.memories.length && <p>本次没有加载明确记忆。</p>}</>;
  return <>{snapshot.memoryContexts.map(context => <section key={context.scope.kind}><h4>{context.scope.kind === 'agent' ? 'Agent 个人记忆' : 'Room 记忆'}</h4><p>本次加载 {context.items.length} 项 · {context.characters} 字符 · {context.deferred} 项未加载{context.stale ? ` · ${context.stale} 条旧摘要已失效` : ''}</p>
    {context.items.map((item, index) => <article key={index}><p>{item.kind === 'summary' ? '整理摘要' : '原始记录'}</p><p>{item.text}</p>{item.kind === 'summary' && <><p>整理依据：{item.reason}</p><small>整理批次：{item.runId}</small></>}<FrozenSources client={client} workspaceId={workspaceId} scope={context.scope} refs={item.refs} /></article>)}{!context.items.length && <p>本次未加载此范围的记忆。</p>}
  </section>)}</>;
}

export function TaskMemoryContext({ client, roomId, taskId }: { client: ChatClient; roomId: string; taskId: string }) {
  const [value, setValue] = useState<QueryResult<'taskContextSnapshot'> | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const lock = useRef(false), alive = useRef(true);
  useEffect(() => () => { alive.current = false; }, []);
  async function load() { if (lock.current) return; lock.current = true; setBusy(true); setError(''); try { const result = await client.query({ type: 'taskContextSnapshot', roomId, taskId }); if (alive.current) setValue(result); } catch (e) { if (alive.current) setError(errorText(e)); } finally { lock.current = false; if (alive.current) setBusy(false); } }
  return <details className="memory-context" onToggle={e => { if (e.currentTarget.open && !value) void load(); }}><summary>任务启动时的 Soul 与记忆</summary>
    <p>这是本次任务实际使用的版本；之后修改配置不会改变这份快照。</p>{busy && <p role="status">正在读取…</p>}{error && <p role="alert">{error}</p>}
    {value?.status === 'available' && <><p>Agent {value.snapshot.agentId} · Soul {value.snapshot.soulRevision === null ? '未配置' : `v${value.snapshot.soulRevision}`}</p><p>快照：{value.snapshot.snapshotId} · {value.snapshot.createdAt}</p><FrozenMemories client={client} workspaceId={client.read().rooms.find(r => r.id === roomId)?.workspaceId || ''} snapshot={value.snapshot} /><details><summary>实际注入内容（含任务原文）</summary><pre data-task-context-prompt>{value.snapshot.prompt}</pre></details></>}
    {value?.status === 'not_started' && <p>任务尚未启动，尚未生成配置快照。</p>}{value?.status === 'not_recorded' && <p>旧任务未记录启动快照，无法还原当时配置。</p>}
    <button className="button" disabled={busy} onClick={() => void load()}>重新读取任务快照</button>
  </details>;
}
