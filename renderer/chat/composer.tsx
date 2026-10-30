import React, { useEffect, useRef, useState } from 'react';
import type { Agent, ChatClient, Command, Room } from './types';
import { useEntrance } from './motion';

export type Draft = { text: string; mentions: { agentId: string; start: number; end: number }[]; submittedKey?: string };
export function Composer({ client, room, agents, portrait, openMembers, membersOpen, draft, updateDraft, live, tasks, mock, persistent = false, pendingOperations = [], onError }: {
  client: ChatClient; room: Room; agents: Agent[]; draft: Draft; updateDraft(draft: Draft): void;
  portrait(agent: Agent): string; openMembers(): void; membersOpen: boolean;
  live: boolean; tasks: boolean; mock: boolean; onError(message: string): void;
  persistent?: boolean; pendingOperations?: { key: string; outcome: string }[];
}) {
  const input = useRef<HTMLTextAreaElement>(null), composing = useRef(false), submitting = useRef(false);
  const [cursor, setCursor] = useState(0), [selectionEnd, setSelectionEnd] = useState(0), [menuClosed, setMenuClosed] = useState(false);
  const [highlighted, setHighlighted] = useState(0), [busy, setBusy] = useState(false), [mode, setMode] = useState<'discussion' | 'task'>('discussion');
  const [owner, setOwner] = useState(room.ownerAgentId || ''), [uncertain, setUncertain] = useState(false);
  const locked = uncertain || persistent && pendingOperations.length > 0;
  const [recoveredMessageId, setRecoveredMessageId] = useState<string | null>(null);
  const draftRef = useRef(draft); draftRef.current = draft;
  const recoveredMessage = client.read().messages.find(m => m.id === recoveredMessageId);
  useEffect(() => {
    if (!recoveredMessage) return;
    if (draftRef.current.submittedKey && recoveredMessage.text === draftRef.current.text) updateDraft({ text: '', mentions: [] });
    setRecoveredMessageId(null);
  }, [recoveredMessage]);
  useEffect(() => {
    if (!persistent || !live || busy || !draft.submittedKey) return;
    let current = true;
    void client.checkOperation?.(draft.submittedKey).then(receipt => { if (current && receipt) { setUncertain(false); setRecoveredMessageId(receipt.messageId || null); } }).catch(() => {});
    return () => { current = false; };
  }, [client, persistent, live, busy, draft.submittedKey]);
  const position = persistent || menuClosed || composing.current ? null : window.AgentMentions.context(draft.text, cursor, selectionEnd);
  const candidates = position ? agents.filter(a => `${a.name} ${a.displayName}`.toLowerCase().includes(position.query.toLowerCase())) : [];
  const menu = Boolean(position);
  const menuRef = useRef<HTMLDivElement>(null), optionsRef = useRef<HTMLDetailsElement>(null);
  const [compact, setCompact] = useState(false), [optionsOpen, setOptionsOpen] = useState(false);
  useEntrance(menuRef, menu, 'popover');
  useEffect(() => {
    const area = input.current?.closest('.composer-area'); if (!area) return;
    const observer = new ResizeObserver(entries => setCompact(entries[0].contentRect.width <= 520));
    observer.observe(area); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!compact || !optionsOpen) return;
    const outside = (event: PointerEvent) => { if (!optionsRef.current?.contains(event.target as Node)) setOptionsOpen(false); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [compact, optionsOpen]);
  const selectedAgents = agents.filter(a => draft.mentions.some(m => m.agentId === a.id));
  useEffect(() => { if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${Math.max(64, Math.min(180, input.current.scrollHeight))}px`; } }, [draft.text]);
  function selectCursor() { if (input.current) { setCursor(input.current.selectionStart); setSelectionEnd(input.current.selectionEnd); setMenuClosed(false); } }
  function edited(next: string, nextCursor: number) {
    // Keep only explicit selections, adjusting ranges across the one contiguous text edit.
    const old = draftRef.current;
    let start = 0; while (start < old.text.length && start < next.length && old.text[start] === next[start]) start++;
    let suffix = 0; while (suffix < old.text.length - start && suffix < next.length - start && old.text.at(-1 - suffix) === next.at(-1 - suffix)) suffix++;
    const oldEnd = old.text.length - suffix, delta = next.length - old.text.length;
    const mentions = old.mentions.flatMap(m => m.end <= start ? [m] : m.start >= oldEnd ? [{ ...m, start: m.start + delta, end: m.end + delta }] : []).filter(m => !/[a-zA-Z0-9_/-]/.test(next[m.end] || ''));
    updateDraft({ text: next, mentions }); setCursor(nextCursor); setSelectionEnd(nextCursor); setHighlighted(0); setMenuClosed(false);
  }
  function insertAgent(agent: Agent) {
    if (!position) return;
    const next = window.AgentMentions.insert(draft.text, position, agent.name);
    const delta = next.text.length - draft.text.length;
    const mentions = draft.mentions.flatMap(m => m.end <= position.start ? [m] : m.start >= position.end ? [{ ...m, start: m.start + delta, end: m.end + delta }] : []);
    mentions.push({ agentId: agent.id, start: position.start, end: position.start + agent.name.length + 1 });
    updateDraft({ text: next.text, mentions }); setCursor(next.cursor); setSelectionEnd(next.cursor); setMenuClosed(true);
    requestAnimationFrame(() => { input.current?.focus(); input.current?.setSelectionRange(next.cursor, next.cursor); });
  }
  async function send() {
    if (submitting.current || !live || !draft.text.trim() || locked) return;
    const key = crypto.randomUUID();
    const submitted = draft, command: Command = { type: 'send', key, roomId: room.id, text: draft.text, mode, ownerAgentId: room.type === 'dm' ? room.memberIds[0] : owner || null, mentions: draft.mentions };
    submitting.current = true; setBusy(true); setMenuClosed(true); setOptionsOpen(false);
    if (persistent) updateDraft({ ...draft, submittedKey: key });
    try { await client.dispatch(command); if (draftRef.current.text === submitted.text) updateDraft({ text: '', mentions: [] }); }
    catch (error) { const e = error as Error & { outcome?: string }; if (e.outcome === 'unknown') setUncertain(true); onError(e.message); }
    finally { submitting.current = false; setBusy(false); input.current?.focus(); }
  }
  return <div className="composer-area">
    {room.type === 'group' && selectedAgents.length > 0 && <div className="composer-recipients" aria-label="已选参与者"><span>参与者</span>{selectedAgents.map(agent => <button key={agent.id} aria-label={`移除 ${agent.displayName} 的提及`} onClick={() => {
      let text = draft.text;
      const removed = draft.mentions.filter(m => m.agentId === agent.id).sort((a, b) => b.start - a.start);
      for (const mention of removed) text = text.slice(0, mention.start) + text.slice(mention.end);
      const mentions = draft.mentions.filter(m => m.agentId !== agent.id).map(m => { const shift = removed.filter(r => r.end <= m.start).reduce((total, r) => total + r.end - r.start, 0); return { ...m, start: m.start - shift, end: m.end - shift }; });
      updateDraft({ text, mentions }); setMenuClosed(true); requestAnimationFrame(() => input.current?.focus());
    }}><span className="avatar character small"><img src={portrait(agent)} alt="" /></span>{agent.displayName}<span aria-hidden="true">×</span></button>)}</div>}
    <div className="composer" id="composer">
      {menu && <div ref={menuRef} className="mention-menu" id="mention-menu" role="listbox" aria-label="提及成员">
        {candidates.length ? candidates.map((a, i) => <button key={a.id} type="button" id={`mention-${i}`} className={`mention-option ${i === highlighted ? 'highlighted' : ''}`} role="option" aria-selected={i === highlighted}
          onMouseDown={e => e.preventDefault()} onClick={() => insertAgent(a)}><span className="avatar character small"><img src={portrait(a)} alt="" /></span><span className="mention-person"><strong>{a.displayName}</strong><small>{a.engine}</small></span><small className="mention-handle">@{a.name}</small></button>) : <p>没有匹配的成员</p>}
      </div>}
      <textarea ref={input} id="message-input" aria-label="消息内容" aria-autocomplete="list" aria-controls={menu ? 'mention-menu' : undefined} aria-expanded={menu} aria-activedescendant={menu && candidates.length ? `mention-${Math.min(highlighted, candidates.length - 1)}` : undefined}
        placeholder={persistent ? '写下讨论内容…' : room.type === 'dm' ? `和 ${room.title} 继续对话…` : '写下想法，输入 @ 选择参与者…'} value={draft.text} rows={2}
        onChange={e => edited(e.target.value, e.target.selectionStart)} onSelect={selectCursor}
        onCompositionStart={() => { composing.current = true; setMenuClosed(true); }} onCompositionEnd={() => { composing.current = false; selectCursor(); }}
        onKeyDown={e => {
          if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (menu && e.key === 'Escape') { e.preventDefault(); setMenuClosed(true); return; }
          if (menu && candidates.length && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setHighlighted(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length); return; }
          if (menu && candidates.length && e.key === 'Enter') { e.preventDefault(); insertAgent(candidates[Math.min(highlighted, candidates.length - 1)]); return; }
          if (menu && !candidates.length && e.key === 'Enter') { e.preventDefault(); setMenuClosed(true); return; }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
        }} />
      <div className="composer-toolbar"><div className="composer-tools">
        {!persistent && <button className="composer-tool" aria-label="提及成员" onClick={() => {
          const el = input.current!; const start = el.selectionStart, end = el.selectionEnd;
          const inserted = `${start && !/\s/.test(draft.text[start - 1]) ? ' ' : ''}@`;
          edited(draft.text.slice(0, start) + inserted + draft.text.slice(end), start + inserted.length);
          requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + inserted.length, start + inserted.length); });
        }}>@</button>}
        <button className="recipient-button" type="button" aria-label="房间成员" aria-expanded={membersOpen} onClick={openMembers}><span aria-hidden="true" dangerouslySetInnerHTML={{ __html: window.icon('agents') }} /><span className="composer-hint">{room.type === 'dm' ? '当前 Agent' : '房间成员'}</span><span aria-hidden="true" dangerouslySetInnerHTML={{ __html: window.icon('chevron-down') }} /></button>
        {tasks && <details className="composer-options" ref={optionsRef} open={!compact || optionsOpen} onToggle={e => { if (compact) setOptionsOpen(e.currentTarget.open); }} onKeyDown={e => { if (compact && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOptionsOpen(false); optionsRef.current?.querySelector<HTMLElement>('summary')?.focus(); } }}><summary aria-label="消息选项">{mode === 'task' ? '任务' : '讨论'}{mode === 'task' && room.type === 'group' && <span className="composer-owner-hint">{agents.find(a => a.id === owner)?.displayName || '待选负责人'}</span>}<span aria-hidden="true">⌄</span></summary><div className="composer-option-fields"><label><span>消息类型</span><select aria-label="消息类型" value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="discussion">讨论</option><option value="task">任务</option></select></label>
        {mode === 'task' && room.type === 'group' && <select aria-label="任务负责人" value={owner} onChange={e => setOwner(e.target.value)}><option value="">选择负责人</option>{agents.map(a => <option key={a.id} value={a.id}>{a.displayName} 负责</option>)}</select>}
        </div></details>}
      </div><button id="send-button" className="send-button" aria-label="发送消息" disabled={busy || !live || !draft.text.trim() || locked || mode === 'task' && !owner && room.type !== 'dm'} onClick={() => void send()}><span aria-hidden="true">↑</span></button></div>
    </div>
    <div className="composer-bottom"><span>{persistent ? '持久讨论 · 不启动 Agent' : room.type === 'dm' ? `仅与 ${room.title} 对话` : mode === 'task' ? '一位负责人 · @ 添加参与者' : mock ? '@ 邀请回应 · 未提及仅记录讨论' : '请 @ 选择回应者'}</span><span>Enter 发送 · Shift + Enter 换行</span></div>
    {persistent && locked && <p className="chat-inline-error" role="alert">发送结果尚待核查。{pendingOperations.map(operation => <span key={operation.key}>
      <button className="button" data-check-operation disabled={busy || !live} onClick={async () => {
        setBusy(true);
        try { const receipt = await client.checkOperation?.(operation.key); if (receipt) { setUncertain(false); setRecoveredMessageId(receipt.messageId || null); } else onError('原请求尚未找到。可以显式重试已保存的原请求，新草稿会保留。'); }
        catch (e) { onError((e as Error).message); } finally { setBusy(false); }
      }}>核查原请求</button>
      {operation.outcome === 'not_found' && <button className="button" data-retry-operation disabled={busy || !live} onClick={async () => {
        setBusy(true);
        try { const receipt = await client.retryOperation?.(operation.key); setUncertain(false); setRecoveredMessageId(receipt?.messageId || null); }
        catch (e) { onError((e as Error).message); } finally { setBusy(false); }
      }}>重试原请求</button>}
    </span>)}{!pendingOperations.length && <button className="button" onClick={() => { setUncertain(false); onError('原请求已核查，请确认消息记录后继续。'); }}>查看核查结果</button>}</p>}
    {uncertain && !persistent && <p className="chat-inline-error" role="alert">发送结果未知。请先核查记录。<button className="button" onClick={() => setUncertain(false)}>已核查，恢复发送</button></p>}
  </div>;
}
