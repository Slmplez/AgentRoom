import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import type { Agent, Message, ChatClient } from './types';
import { useEntrance } from './motion';

const toolStatus = (status: string) => ({ completed: '已完成', running: '执行中', failed: '失败', cancelled: '已中断', ended: '已结束', unknown: '结果未知' } as Record<string, string>)[status] || '等待中';
const brief = (text: string) => { const line = text.trim().split(/\r?\n/)[0] || ''; return line.length > 100 ? `${line.slice(0, 100)}…` : line; };

const ThreadContext = createContext<{ client?: ChatClient; group?: boolean; statusMessageIds?: string[]; messages: Message[]; agents: Agent[]; portrait(agent: Agent): string; showDiff(patches: string[]): void; expanded?: Record<string, boolean>; onExpanded?(id: string, value: boolean): void }>({ messages: [], agents: [], portrait: () => '', showDiff: () => {} });
const convertMessage = (message: ThreadMessageLike) => message;
const MarkdownText = () => <MarkdownTextPrimitive />;
export function ChatThread({ client, group = false, statusMessageIds = [], messages, agents, portrait, showDiff, expanded = {}, onExpanded }: React.ContextType<typeof ThreadContext>) {
  const converted = useMemo<ThreadMessageLike[]>(() => messages.map(m => ({
    id: m.id, role: m.role, content: [{ type: 'text', text: m.text }], createdAt: new Date(m.createdAt || 0),
    ...(m.role === 'assistant' ? { status: m.status === 'running' ? { type: 'running' as const } : { type: 'complete' as const, reason: 'stop' as const } } : {}),
  })), [messages]);
  const runtime = useExternalStoreRuntime({ messages: converted, convertMessage, isRunning: messages.some(m => m.status === 'running'), onNew: async () => { throw new Error('请使用会话输入框发送。'); } });
  return <ThreadContext.Provider value={{ client, group, statusMessageIds, messages, agents, portrait, showDiff, expanded, onExpanded }}><AssistantRuntimeProvider runtime={runtime}>
    <ThreadPrimitive.Root className="chat-thread">
      <ThreadPrimitive.Viewport className="messages" id="messages" aria-label="消息记录" scrollToBottomOnRunStart={false}>
        {!messages.length && <div className="welcome"><div className="welcome-kicker">AGENT ROOM</div><h2>今天，一起完成什么？</h2><p>写下想法，或者邀请一位 Agent 加入讨论。</p></div>}
        <ThreadPrimitive.Messages components={{ Message: MessageRow }} />
      </ThreadPrimitive.Viewport>
      <ThreadPrimitive.ScrollToBottom className="chat-scroll-bottom" aria-label="回到最新消息">↓ 最新消息</ThreadPrimitive.ScrollToBottom>
    </ThreadPrimitive.Root>
  </AssistantRuntimeProvider></ThreadContext.Provider>;
}
function MessageRow() {
  const id = useAuiState(s => s.message.id), context = useContext(ThreadContext);
  const message = context.messages.find(m => m.id === id);
  if (!message) return null;
  const agent = context.agents.find(a => a.id === message.authorId);
  const statusCovered = context.group && context.statusMessageIds?.includes(id);
  if (statusCovered && message.status === 'running' && !message.text && !message.tools.length) return null;
  return <MessagePrimitive.Root className={`message ${context.group ? 'group-message' : ''} ${message.role === 'user' ? 'human' : ''}`} data-message-id={id}>
    {message.role !== 'user' && <span className="avatar character">{agent && <img src={context.portrait(agent)} alt="" />}</span>}
    <div className="message-main"><div className={`message-heading ${message.role === 'user' && message.authorName === '你' ? 'chat-visually-hidden' : ''}`}><span className="message-name">{message.authorName}</span>{agent && !context.group && <span className="message-engine">{agent.engine}</span>}</div>
      <div className="message-bubble chat-markdown"><MessagePrimitive.Parts components={{ Text: MarkdownText }} />{message.status === 'running' && !message.text && <span className="chat-thinking" role="status">正在回应…</span>}</div>
      {!statusCovered && message.status !== 'running' && message.status !== 'complete' && <p className="chat-inline-error" role="status">{message.status === 'unknown' ? '执行结果尚未确认' : message.status === 'cancelled' ? '已中断' : '执行失败'}</p>}
      {context.group && message.tools.some(t => t.hasDiff || t.patches.length > 0) && <MessageChanges key={message.id} tools={message.tools} context={context} />}
      {message.tools.some(t => ['failed', 'unknown', 'cancelled'].includes(t.status)) && <p className="process-attention" role="status">{message.tools.some(t => t.status === 'failed') ? '有操作失败，请查看过程核查' : message.tools.some(t => t.status === 'unknown') ? '有操作结果未知，请查看过程核查' : '有操作已中断'}</p>}
      {message.tools.length > 0 && <MessageProcess message={message} context={context} />}
    </div>
  </MessagePrimitive.Root>;
}

function MessageProcess({ message, context }: { message: Message; context: React.ContextType<typeof ThreadContext> }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const process = <details className="tool-trace" open={context.expanded?.[message.id]} onToggle={e => context.onExpanded?.(message.id, e.currentTarget.open)}><summary>{context.group ? '查看过程' : <><span>工具使用 · {message.tools.length} 次</span><span className="tool-overview">{message.tools.some(t => t.status === 'failed') ? '有操作失败' : message.tools.some(t => t.status === 'unknown') ? '有结果待核查' : message.tools.some(t => t.status === 'running') ? '执行中' : message.tools.every(t => t.status === 'completed') ? '已完成' : '查看进展'}</span></>}</summary>
    {message.tools.map(tool => <ToolRow key={tool.id} tool={tool} messageId={message.id} context={context} />)}
  </details>;
  if (!context.group) return process;
  return <details ref={menu} className="message-process-menu" onKeyDown={e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); menu.current!.open = false; menu.current!.querySelector('summary')?.focus(); }
  }}><summary aria-label={`${message.authorName} 的消息操作`}>更多</summary><div className="message-action-content">{process}</div></details>;
}

function MessageChanges({ tools, context }: { tools: Message['tools']; context: React.ContextType<typeof ThreadContext> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const active = useRef(true), pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function open() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      const results = await Promise.all(tools.filter(t => t.hasDiff || t.patches.length > 0).map(t => t.detailRef && context.client ? context.client.query({ type: 'toolDetails', ref: t.detailRef }) : Promise.resolve({ patches: t.patches, truncated: t.truncated })));
      if (!active.current) return;
      const patches = results.flatMap(r => r.patches);
      if (!patches.length) throw new Error('当前没有可用变更，请展开过程核查。');
      if (results.some(r => r.truncated)) setNotice('部分内容超过预览范围，可展开过程查看详情。');
      context.showDiff(patches);
    } catch (e) { if (active.current) setError((e as Error).message); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }
  return <div className="message-results"><button className="message-result-link" disabled={busy} onClick={() => void open()}>{busy ? '正在读取变更…' : '查看变更'}</button>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</div>;
}

function ToolRow({ tool, messageId, context }: { tool: Message['tools'][number]; messageId: string; context: React.ContextType<typeof ThreadContext> }) {
  const [output, setOutput] = useState(''), [error, setError] = useState(''), [loading, setLoading] = useState(false);
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const load = async (diff: boolean) => {
    setError(''); setLoading(true);
    try {
      const result = tool.detailRef && context.client ? await context.client.query({ type: 'toolDetails', ref: tool.detailRef }) : { output: tool.output, patches: tool.patches, truncated: tool.truncated };
      if (!active.current) return;
      setOutput(result.output + (result.truncated ? '\n部分输出或差异超过预览限制。' : ''));
      if (diff) { if (result.patches.length) context.showDiff(result.patches); else setError('没有可用差异。'); }
    } catch (e) { if (active.current) setError((e as Error).message); }
    finally { if (active.current) setLoading(false); }
  };
  const key = `${messageId}:${tool.id}`;
  return <details className="tool-step" open={context.expanded?.[key]} onToggle={e => context.onExpanded?.(key, e.currentTarget.open)}>
    <summary><span className="tool-description"><strong>{tool.name}</strong>{tool.detail && <small>{brief(tool.detail)}</small>}</span><span className={`tool-status tool-status-${tool.status}`}>{toolStatus(tool.status)}</span></summary>
    {tool.detail && <details className="tool-payload"><summary>查看输入内容</summary><pre>{tool.detail}</pre></details>}
    {(output || tool.output) && <details className="tool-payload" open={Boolean(output)}><summary>输出结果</summary><pre>{output || tool.output}</pre></details>}{tool.truncated && <p className="tool-note">内容有截断，详情按需读取。</p>}
    <div className="tool-actions">{tool.detailRef && <button className="button" disabled={loading} onClick={() => void load(false)}>查看输出详情</button>}
    {(tool.hasDiff || tool.patches.length > 0) && <button className="button" disabled={loading} onClick={() => void load(true)}>查看文件差异</button>}</div>
    {loading && <span role="status">正在读取…</span>}{error && <p role="alert">{error}</p>}
  </details>;
}

export function DiffDialog({ patches, close, theme }: { patches: string[]; close(): void; theme: string }) {
  const dialog = useRef<HTMLDialogElement>(null), container = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<'unified' | 'split'>('unified'), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); previous?.isConnected && previous.focus(); }; }, []);
  useEntrance(dialog, true, 'dialog');
  useEffect(() => {
    let active = true; const views: { cleanUp(): void }[] = []; setError(''); setLoading(true);
    const host = container.current!; host.replaceChildren();
    // Keep the large highlighter split from the chat entry and use the same local Pierre build.
    const url = new URL('./vendor/diffs/diffs.js', document.baseURI).href;
    void import(/* @vite-ignore */ url).then(library => {
      if (!active) return;
      const files = patches.flatMap(p => library.parsePatchFiles(p, undefined, true).flatMap((patch: { files: unknown[] }) => patch.files));
      if (!files.length) throw new Error('没有可解析的差异');
      for (const fileDiff of files) {
        const element = document.createElement('diffs-container'); host.append(element);
        const view = new library.FileDiff({ diffStyle: style, theme: { light: 'pierre-light', dark: 'pierre-dark' }, themeType: theme, preferredHighlighter: 'shiki-js', overflow: 'scroll', disableErrorHandling: true });
        views.push(view); view.render({ fileDiff, fileContainer: element });
      }
      setLoading(false);
    }).catch(e => { if (active) { views.forEach(v => v.cleanUp()); host.replaceChildren(); setError(e.message); setLoading(false); } });
    return () => { active = false; views.forEach(v => v.cleanUp()); host.replaceChildren(); };
  }, [patches, style, theme]);
  return <dialog ref={dialog} className="chat-diff-dialog" aria-labelledby="diff-title" onCancel={e => { e.preventDefault(); close(); }}><div className="permission-heading"><h2 id="diff-title">文件变更</h2><button className="button" onClick={close}>关闭</button></div>
    <div className="diff-controls">{(['unified', 'split'] as const).map(value => <button className="button" key={value} aria-pressed={style === value} onClick={() => setStyle(value)}>{value === 'unified' ? '合并' : '并排'}</button>)}<span>只读预览</span></div>
    {loading && <p role="status">正在加载差异…</p>}{error && <><p role="alert">无法显示差异：{error}</p><pre>{patches.join('\n')}</pre></>}
    <div ref={container} />
  </dialog>;
}
