import React, { useEffect, useRef, useState } from 'react';
import type { Agent, ChatClient, Command, Room } from './types';

export type Draft = { text: string; mentions: { agentId: string; start: number; end: number }[] };
export function Composer({ client, room, agents, draft, updateDraft, live, tasks, mock, onError }: {
  client: ChatClient; room: Room; agents: Agent[]; draft: Draft; updateDraft(draft: Draft): void;
  live: boolean; tasks: boolean; mock: boolean; onError(message: string): void;
}) {
  const input = useRef<HTMLTextAreaElement>(null), composing = useRef(false), submitting = useRef(false);
  const [cursor, setCursor] = useState(0), [selectionEnd, setSelectionEnd] = useState(0), [menuClosed, setMenuClosed] = useState(false);
  const [highlighted, setHighlighted] = useState(0), [busy, setBusy] = useState(false), [mode, setMode] = useState<'discussion' | 'task'>('discussion');
  const [owner, setOwner] = useState(room.ownerAgentId || ''), [uncertain, setUncertain] = useState(false);
  const draftRef = useRef(draft); draftRef.current = draft;
  const position = menuClosed || composing.current ? null : window.AgentMentions.context(draft.text, cursor, selectionEnd);
  const candidates = position ? agents.filter(a => `${a.name} ${a.displayName}`.toLowerCase().includes(position.query.toLowerCase())) : [];
  const menu = Boolean(position);
  useEffect(() => { if (input.current) { input.current.style.height = 'auto'; input.current.style.height = `${Math.max(64, Math.min(180, input.current.scrollHeight))}px`; } }, [draft.text]);
  function selectCursor() { if (input.current) { setCursor(input.current.selectionStart); setSelectionEnd(input.current.selectionEnd); setMenuClosed(false); } }
  function edited(next: string, nextCursor: number) {
    // Keep only explicit selections, adjusting ranges across the one contiguous text edit.
    const old = draftRef.current;
    let start = 0; while (start < old.text.length && start < next.length && old.text[start] === next[start]) start++;
    let suffix = 0; while (suffix < old.text.length - start && suffix < next.length - start && old.text.at(-1 - suffix) === next.at(-1 - suffix)) suffix++;
    const oldEnd = old.text.length - suffix, delta = next.length - old.text.length;
    const mentions = old.mentions.flatMap(m => m.end <= start ? [m] : m.start >= oldEnd ? [{ ...m, start: m.start + delta, end: m.end + delta }] : []);
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
    if (submitting.current || !live || !draft.text.trim() || uncertain) return;
    const submitted = draft, command: Command = { type: 'send', key: crypto.randomUUID(), roomId: room.id, text: draft.text, mode, ownerAgentId: room.type === 'dm' ? room.memberIds[0] : owner || null, mentions: draft.mentions };
    submitting.current = true; setBusy(true); setMenuClosed(true);
    try { await client.dispatch(command); if (draftRef.current.text === submitted.text) updateDraft({ text: '', mentions: [] }); }
    catch (error) { const e = error as Error & { outcome?: string }; if (e.outcome === 'unknown') setUncertain(true); onError(e.message); }
    finally { submitting.current = false; setBusy(false); input.current?.focus(); }
  }
  return <div className="composer-area">
    <div className="composer" id="composer">
      {menu && <div className="mention-menu" id="mention-menu" role="listbox" aria-label="提及成员">
        {candidates.length ? candidates.map((a, i) => <button key={a.id} type="button" id={`mention-${i}`} className={`mention-option ${i === highlighted ? 'highlighted' : ''}`} role="option" aria-selected={i === highlighted}
          onMouseDown={e => e.preventDefault()} onClick={() => insertAgent(a)}><strong>{a.displayName}</strong><small>@{a.name}</small></button>) : <p>没有匹配的成员</p>}
      </div>}
      <textarea ref={input} id="message-input" aria-label="消息内容" aria-autocomplete="list" aria-controls={menu ? 'mention-menu' : undefined} aria-expanded={menu} aria-activedescendant={menu && candidates.length ? `mention-${Math.min(highlighted, candidates.length - 1)}` : undefined}
        placeholder={room.type === 'dm' ? `和 ${room.title} 继续对话…` : '写下想法，输入 @ 选择参与者…'} value={draft.text} rows={2}
        onChange={e => edited(e.target.value, e.target.selectionStart)} onSelect={selectCursor}
        onCompositionStart={() => { composing.current = true; setMenuClosed(true); }} onCompositionEnd={() => { composing.current = false; selectCursor(); }}
        onKeyDown={e => {
          if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
          if (menu && e.key === 'Escape') { e.preventDefault(); setMenuClosed(true); return; }
          if (menu && candidates.length && ['ArrowDown', 'ArrowUp'].includes(e.key)) { e.preventDefault(); setHighlighted(i => (i + (e.key === 'ArrowDown' ? 1 : -1) + candidates.length) % candidates.length); return; }
          if (menu && candidates.length && e.key === 'Enter') { e.preventDefault(); insertAgent(candidates[Math.min(highlighted, candidates.length - 1)]); return; }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
        }} />
      <div className="composer-toolbar"><div className="composer-tools">
        <button className="composer-tool" aria-label="提及成员" onClick={() => {
          const el = input.current!; const start = el.selectionStart, end = el.selectionEnd;
          const inserted = `${start && !/\s/.test(draft.text[start - 1]) ? ' ' : ''}@`;
          edited(draft.text.slice(0, start) + inserted + draft.text.slice(end), start + inserted.length);
          requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + inserted.length, start + inserted.length); });
        }}>@</button>
        {tasks && <select aria-label="消息类型" value={mode} onChange={e => setMode(e.target.value as typeof mode)}><option value="discussion">讨论</option><option value="task">任务</option></select>}
        {mode === 'task' && room.type === 'group' && <select aria-label="任务负责人" value={owner} onChange={e => setOwner(e.target.value)}><option value="">选择负责人</option>{agents.map(a => <option key={a.id} value={a.id}>{a.displayName} 负责</option>)}</select>}
      </div><button id="send-button" className="send-button" aria-label="发送消息" disabled={busy || !live || !draft.text.trim() || uncertain || mode === 'task' && !owner && room.type !== 'dm'} onClick={() => void send()}><span aria-hidden="true">↑</span></button></div>
    </div>
    <div className="composer-bottom"><span>{room.type === 'dm' ? `仅与 ${room.title} 对话` : mode === 'task' ? '一位负责人 · @ 添加参与者' : mock ? '@ 邀请回应 · 未提及仅记录讨论' : '请 @ 选择回应者'}</span><span>Enter 发送 · Shift + Enter 换行</span></div>
    {uncertain && <p className="chat-inline-error" role="alert">发送结果未知。请先核查记录。<button className="button" onClick={() => setUncertain(false)}>已核查，恢复发送</button></p>}
  </div>;
}
