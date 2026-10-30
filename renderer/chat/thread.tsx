import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AssistantRuntimeProvider, MessagePrimitive, ThreadPrimitive, useAuiState, useExternalStoreRuntime, type ThreadMessageLike } from '@assistant-ui/react';
import { MarkdownTextPrimitive } from '@assistant-ui/react-markdown';
import type { Agent, Message } from './types';

const ThreadContext = createContext<{ messages: Message[]; agents: Agent[]; portrait(agent: Agent): string; showDiff(patches: string[]): void; expanded?: Record<string, boolean>; onExpanded?(id: string, value: boolean): void }>({ messages: [], agents: [], portrait: () => '', showDiff: () => {} });
const convertMessage = (message: ThreadMessageLike) => message;
const MarkdownText = () => <MarkdownTextPrimitive />;
export function ChatThread({ messages, agents, portrait, showDiff, expanded = {}, onExpanded }: React.ContextType<typeof ThreadContext>) {
  const converted = useMemo<ThreadMessageLike[]>(() => messages.map(m => ({
    id: m.id, role: m.role, content: [{ type: 'text', text: m.text }], createdAt: new Date(m.createdAt || 0),
    ...(m.role === 'assistant' ? { status: m.status === 'running' ? { type: 'running' as const } : { type: 'complete' as const, reason: 'stop' as const } } : {}),
  })), [messages]);
  const runtime = useExternalStoreRuntime({ messages: converted, convertMessage, isRunning: messages.some(m => m.status === 'running'), onNew: async () => { throw new Error('请使用会话输入框发送。'); } });
  return <ThreadContext.Provider value={{ messages, agents, portrait, showDiff, expanded, onExpanded }}><AssistantRuntimeProvider runtime={runtime}>
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
  return <MessagePrimitive.Root className={`message ${message.role === 'user' ? 'human' : ''}`} data-message-id={id}>
    {message.role !== 'user' && <span className="avatar character">{agent && <img src={context.portrait(agent)} alt="" />}</span>}
    <div className="message-main"><div className="message-heading"><span className="message-name">{message.authorName}</span>{agent && <span className="message-engine">{agent.engine}</span>}</div>
      <div className="message-bubble chat-markdown"><MessagePrimitive.Parts components={{ Text: MarkdownText }} />{message.status === 'running' && !message.text && <span className="chat-thinking" role="status">正在回应…</span>}</div>
      {message.status !== 'running' && message.status !== 'complete' && <p className="chat-inline-error" role="status">{message.status === 'unknown' ? '执行结果尚未确认' : message.status === 'cancelled' ? '已中断' : '执行失败'}</p>}
      {message.tools.length > 0 && <details className="tool-trace" open={context.expanded?.[id]} onToggle={e => context.onExpanded?.(id, e.currentTarget.open)}><summary>工具使用 · {message.tools.length} 次{message.tools.some(t => t.status === 'failed') ? ' · 有操作失败' : ''}</summary>
        {message.tools.map(tool => <details className="tool-step" key={tool.id} open={context.expanded?.[`${id}:${tool.id}`]} onToggle={e => context.onExpanded?.(`${id}:${tool.id}`, e.currentTarget.open)}><summary>{tool.name} <span>{({ completed: '完成', running: '执行中', failed: '失败', cancelled: '已中断', ended: '已结束', unknown: '结果未知' } as Record<string, string>)[tool.status] || '等待中'}</span></summary><pre>{tool.detail}</pre>{tool.output && <pre>{tool.output}</pre>}{tool.patches.length > 0 && <button className="button" onClick={() => context.showDiff(tool.patches)}>查看文件差异</button>}</details>)}
      </details>}
    </div>
  </MessagePrimitive.Root>;
}

export function DiffDialog({ patches, close, theme }: { patches: string[]; close(): void; theme: string }) {
  const dialog = useRef<HTMLDialogElement>(null), container = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<'unified' | 'split'>('unified'), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; dialog.current?.showModal(); return () => { dialog.current?.close(); previous?.isConnected && previous.focus(); }; }, []);
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
