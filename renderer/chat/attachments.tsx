import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Attachment, ChatClient } from './types';
import { attachmentExtensions, attachmentLimits } from '../../contracts/attachments.mjs';
import './attachments.css';

const sizeLabel = (size: number) => size < 1024 ? `${size} B` : size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KiB` : `${(size / 1024 / 1024).toFixed(1)} MiB`;

export function AttachmentPicker({ client, roomId, workspaceId, selected, change, disabled, busyChanged, compact = false, toolbarTarget }: { compact?: boolean; toolbarTarget?: HTMLElement | null; client: ChatClient; roomId: string; workspaceId: string; selected: string[]; change(ids: string[]): void; disabled: boolean; busyChanged(busy: boolean): void }) {
  const [files, setFiles] = useState<Attachment[]>([]), [afterId, setAfterId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const filesRef=useRef(files); filesRef.current=files;
  const input = useRef<HTMLInputElement>(null), abort = useRef<AbortController | null>(null), retryKey = useRef<string | undefined>(undefined), active = useRef(true), working = useRef(false);
  const current = useRef({ selected, change }); current.current = { selected, change };
  const [, rerender] = useState(0);
  const pending = (client.read().pendingOperations || []).filter(o => o.type === 'uploadAttachment' || o.type === 'removeAttachment');
  const scope = `${client.read().databaseId}:${roomId}`;
  useEffect(() => {
    active.current = true; let reading = false, again = false;
    async function refresh() {
      rerender(n => n + 1);
      if (reading) { again = true; return; }
      reading = true;
      try {
        const data = await client.query({ type: 'pendingAttachments', roomId });
        if (active.current) { setFiles(data.attachments); setAfterId(data.afterId); }
      } catch (e) { if (active.current && client.read().connection === 'live') setError((e as Error).message); }
      finally { reading = false; if (again && active.current) { again = false; void refresh(); } }
    }
    void refresh(); const unsubscribe = client.subscribe(() => { if (active.current) void refresh(); });
    return () => { active.current = false; unsubscribe(); abort.current?.abort(); };
  }, [client, roomId, scope]);
  function select(file: Attachment, checked: boolean) {
    const ids = current.current.selected;
    if (!checked) { change(ids.filter(id => id !== file.id)); return; }
    if (ids.length >= attachmentLimits.count || files.filter(f => ids.includes(f.id)).reduce((n, f) => n + f.size, file.size) > attachmentLimits.totalBytes) { setError('每条消息最多 5 个附件，合计不超过 20 MiB。'); return; }
    change([...ids, file.id]); setError('');
  }
  async function upload(chosen: FileList | null) {
    const list = Array.from(chosen || []), key = retryKey.current; retryKey.current = undefined;
    if (input.current) input.current.value = '';
    if (!list.length || working.current || !client.uploadAttachment) return;
    if (key && list.length !== 1) { setError('重试时请仅选择原来的一个文件。'); return; }
    working.current = true; setBusy(true); busyChanged(true); setError(''); setNotice(''); abort.current = new AbortController();
    try {
      for (const file of list) {
        if (!active.current || abort.current.signal.aborted) break;
        const receipt = await client.uploadAttachment({ key: key || crypto.randomUUID(), roomId, name: file.name, file, signal: abort.current.signal });
        if (!active.current) return;
        const attachment = receipt.attachment;
        if (attachment) {
          filesRef.current=[attachment,...filesRef.current.filter(f=>f.id!==attachment.id)];
          setFiles(filesRef.current);
          if (current.current.selected.length < attachmentLimits.count && filesRef.current.filter(f=>current.current.selected.includes(f.id)).reduce((total,f)=>total+f.size,attachment.size)<=attachmentLimits.totalBytes && !current.current.selected.includes(attachment.id)) {
            const ids = [...current.current.selected, attachment.id]; current.current = { ...current.current, selected: ids }; current.current.change(ids);
          }
        }
      }
      if (active.current) setNotice('附件已暂存。点击发送后才会加入讨论；未发送的附件保留 24 小时。');
    } catch (e) { if (active.current) setError((e as Error).message); }
    finally { working.current = false; if (active.current) { setBusy(false); busyChanged(false); } }
  }
  async function remove(file: Attachment) {
    if (working.current) return;
    working.current = true; setBusy(true); busyChanged(true); setError('');
    try {
      await client.dispatch({ type: 'removeAttachment', workspaceId, roomId, attachmentId: file.id, key: crypto.randomUUID(), schemaVersion: 1 });
      if (active.current) { current.current.change(current.current.selected.filter(id => id !== file.id)); setFiles(old => old.filter(f => f.id !== file.id)); }
    } catch (e) { if (active.current) setError((e as Error).message); }
    finally { working.current = false; if (active.current) { setBusy(false); busyChanged(false); } }
  }
  const trigger = <button type="button" className={compact ? 'attachment-trigger' : 'button'} aria-label="添加附件" title="添加附件 · 每个最多 8 MiB · 最多 5 个 · 合计 20 MiB" disabled={disabled || busy || pending.some(p => p.type === 'uploadAttachment')} onClick={() => { retryKey.current = undefined; input.current?.click(); }}>{compact && <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m8 13 6.5-6.5a3 3 0 0 1 4.2 4.2l-8 8a5 5 0 0 1-7-7l8.5-8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/><path d="m7 14 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/></svg>}<span>{busy ? '上传中…' : '附件'}</span></button>;
  return <div className={`attachment-picker${compact ? ' attachment-picker-compact' : ''}`} aria-label="消息附件">
    <input ref={input} type="file" hidden tabIndex={-1} aria-label="选择附件文件" accept={attachmentExtensions.map(ext => `.${ext}`).join(',')} multiple onChange={e => void upload(e.target.files)} />
    {compact ? toolbarTarget && createPortal(trigger, toolbarTarget) : trigger}
    {!compact && <span className="attachment-hint">每个最多 8 MiB · 最多 5 个 · 合计 20 MiB</span>}
    {busy && <button type="button" className="button" onClick={() => abort.current?.abort()}>停止上传并核查</button>}
    {(files.length > 0 || selected.length > 0) && <ul className="attachment-list" aria-label="暂存附件">
      {files.map(file => <li key={file.id}><label><input type="checkbox" checked={selected.includes(file.id)} disabled={disabled || busy} onChange={e => select(file, e.target.checked)} /><span>{file.name}{file.expiresAt && <small className="attachment-expiry">暂存至 {new Date(file.expiresAt).toLocaleString()}</small>}</span><small>{sizeLabel(file.size)}</small></label><button type="button" className="button" aria-label={`移除暂存附件 ${file.name}`} disabled={disabled || busy || pending.some(p => p.type === 'removeAttachment')} onClick={() => void remove(file)}>移除</button></li>)}
      {selected.filter(id => !files.some(file => file.id === id)).map(id => <li key={id}><span>已选附件不在暂存列表中，可能已发送或过期。</span><button type="button" className="button" disabled={disabled || busy} onClick={() => change(selected.filter(value => value !== id))}>取消选择</button></li>)}
    </ul>}
    {afterId && <button type="button" className="button" disabled={busy || disabled} onClick={async () => { try { const data = await client.query({ type: 'pendingAttachments', roomId, afterId }); if (active.current) { setFiles(old => [...new Map([...old, ...data.attachments].map(file => [file.id, file])).values()]); setAfterId(data.afterId); } } catch (e) { if (active.current) setError((e as Error).message); } }}>更多暂存附件</button>}
    {pending.map(item => <div className="attachment-pending" key={item.key} role="status"><span>{item.type === 'uploadAttachment' ? `上传 ${item.name || '附件'}` : '移除附件'}：{item.outcome === 'not_found' ? '未找到回执' : '结果待核查'}</span><button type="button" className="button" disabled={disabled || busy} onClick={async () => { try { const receipt = await client.checkOperation?.(item.key, item.type); if (active.current) setNotice(receipt ? '已找到原请求回执，请从暂存列表选择附件。' : '原请求未找到。上传需重新选择相同文件后明确重试。'); } catch (e) { if (active.current) setError((e as Error).message); } }}>核查原请求</button>{item.outcome === 'not_found' && <button type="button" className="button" disabled={disabled || busy} onClick={async () => { if (item.type === 'uploadAttachment') { retryKey.current = item.key; input.current?.click(); } else { try { await client.retryOperation?.(item.key); } catch (e) { if (active.current) setError((e as Error).message); } } }}>{item.type === 'uploadAttachment' ? '重选文件并重试' : '重试移除'}</button>}</div>)}
    {notice && <p className="attachment-hint" role="status">{notice}</p>}{error && <p className="chat-inline-error" role="alert">{error}</p>}
  </div>;
}

export function MessageAttachments({ client, files }: { client?: ChatClient; files: Attachment[] }) {
  const [busy, setBusy] = useState(''), [error, setError] = useState('');
  const active = useRef(true); useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  if (!files.length) return null;
  async function download(file: Attachment) {
    if (!client?.downloadAttachment || busy) return;
    setBusy(file.id); setError('');
    try {
      const result = await client.downloadAttachment({ roomId: file.roomId, attachmentId: file.id }); if (!active.current) return;
      const url = URL.createObjectURL(result.blob), link = document.createElement('a'); link.href = url; link.download = result.metadata.name; link.hidden = true; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) { if (active.current) setError((e as Error).message); }
    finally { if (active.current) setBusy(''); }
  }
  return <div className="message-attachments"><ul className="attachment-list" aria-label="消息附件">{files.map(file => <li key={file.id}><span>{file.name} <small>{sizeLabel(file.size)}</small></span><button type="button" className="button" disabled={Boolean(busy) || !client?.downloadAttachment} aria-label={`下载 ${file.name}`} onClick={() => void download(file)}>{busy === file.id ? '下载中…' : '下载'}</button></li>)}</ul>{error && <p className="chat-inline-error" role="alert">{error}</p>}</div>;
}
