import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { FileDiffMetadata } from '@pierre/diffs';
import { ReviewDiffFile, ReviewFileNotice, type ReviewClient } from './review-diff-file';

type DiffLibrary = typeof import('@pierre/diffs');
export type WorkspaceChange = {file:string;status:string;patch:string|null;editable:boolean;reason?:string};
type DisplayFile = {name:string;prevName?:string;hunks:FileDiffMetadata['hunks'];data?:FileDiffMetadata;change?:WorkspaceChange};
const counts = (file: Pick<FileDiffMetadata,'hunks'>) => file.hunks.reduce((sum, hunk) => ({ added: sum.added + hunk.additionLines, removed: sum.removed + hunk.deletionLines }), { added: 0, removed: 0 });
function Counts({ added, removed }: { added: number; removed: number }) {
  return <span className="diff-counts" aria-label={`新增 ${added} 行，删除 ${removed} 行`}><span>+{added}</span><span>−{removed}</span></span>;
}
export function DiffPreview({ patches, close, theme, returnFocus, review, changes,refresh,refreshing=false,loadError='' }: { patches: string[]; close(): void; theme: string; returnFocus?: HTMLElement | null; review?: ReviewClient;changes?:WorkspaceChange[];refresh?():void;refreshing?:boolean;loadError?:string }) {
  const panel = useRef<HTMLElement>(null), container = useRef<HTMLDivElement>(null), scroll = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<'summary' | 'unified' | 'split'>('unified');
  const [expanded, setExpanded] = useState(true), [filesOpen, setFilesOpen] = useState(window.innerWidth >= 760);
  const [query, setQuery] = useState(''), [active, setActive] = useState(0), [error, setError] = useState(''), [loading, setLoading] = useState(true);
  const [parsed, setParsed] = useState<{ library: DiffLibrary; files: FileDiffMetadata[] } | null>(null);
  useEffect(() => {
    const previous = returnFocus || document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('h2')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    let current = true; setParsed(null); setError(''); setLoading(true); setActive(0);
    const url = new URL('./vendor/diffs/diffs.js', document.baseURI).href;
    void import(/* @vite-ignore */ url).then((library: DiffLibrary) => {
      const files = patches.flatMap(p => library.parsePatchFiles(p, undefined, true).flatMap(patch => patch.files));
      if (!files.length && !changes) throw Error('没有可解析的差异');
      if(changes?.some(change=>change.patch&&!files.some(file=>file.name===change.file)))throw Error('差异文件路径与工作区列表不匹配');
      if (current) { setParsed({ library, files }); setLoading(false); }
    }).catch(e => { if (current) { setError(e.message); setLoading(false); } });
    return () => { current = false; };
  }, [patches,changes]);
  const files=useMemo<DisplayFile[]>(()=>changes?changes.map(change=>{const data=parsed?.files.find(file=>file.name===change.file);return {name:change.file,hunks:data?.hunks||[],data,change};}):(parsed?.files||[]).map(data=>({...data,data})),[parsed,changes]);
  const total = files.reduce((sum, file) => { const count = counts(file); return { added: sum.added + count.added, removed: sum.removed + count.removed }; }, { added: 0, removed: 0 });
  const groups = useMemo(() => {
    const result = new Map<string, { file: DisplayFile; index: number }[]>();
    files.forEach((file, index) => {
      if (!`${file.name} ${file.prevName || ''}`.toLowerCase().includes(query.toLowerCase().trim())) return;
      const directory = file.name.includes('/') ? file.name.slice(0, file.name.lastIndexOf('/')) : '根目录';
      result.set(directory, [...(result.get(directory) || []), { file, index }]);
    });
    return [...result];
  }, [files, query]);
  const locate = (index: number) => {
    setActive(index); setView(current => current === 'summary' ? 'unified' : current);
    if (panel.current && panel.current.clientWidth < 700) setFilesOpen(false);
    requestAnimationFrame(() => { const target = container.current?.querySelector<HTMLElement>(`[data-diff-file="${index}"]`); target?.scrollIntoView({ block: 'start' }); target?.focus({ preventScroll: true }); });
  };
  return <aside ref={panel} className={`result-panel diff-preview${expanded ? ' diff-expanded' : ''}`} aria-labelledby="diff-title" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } }}>
    <header className="diff-heading"><h2 id="diff-title" tabIndex={-1}>{changes?'工作区变更':'文件变更'}</h2><span>{review ? (review.simulated ? '模拟文件 · 自动保存' : '评论与编辑') : '只读'}</span><div>{refresh&&<button className="diff-icon-button" onClick={refresh} disabled={refreshing} aria-label="刷新工作区变更">{refreshing?'读取中…':'刷新'}</button>}<button className="diff-icon-button" aria-label={expanded ? '收起变更工作区' : '展开变更工作区'} title={expanded ? '收起' : '展开'} onClick={() => { setExpanded(!expanded); setFilesOpen(!expanded && window.innerWidth >= 760); }}>{expanded ? '↙' : '↗'}</button><button className="diff-icon-button" onClick={close} aria-label="关闭文件变更" title="关闭">关闭</button></div></header>
    <div className="diff-view-toolbar"><div className="diff-overview"><span>{files.length} 个文件</span><Counts {...total} /></div><div className="diff-view-actions"><div className="diff-view-switch" role="group" aria-label="文件变更视图">{([{ value: 'summary', label: '摘要' }, { value: 'unified', label: '合并视图' }, { value: 'split', label: '并排视图' }] as const).map(item => <button key={item.value} aria-pressed={view === item.value} onClick={() => setView(item.value)}>{item.label}</button>)}</div><button className="diff-icon-button" aria-label="文件列表" aria-expanded={filesOpen} aria-controls="diff-file-list" title="文件列表" onClick={() => setFilesOpen(!filesOpen)}><svg viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true"><rect x="2" y="3" width="14" height="12" rx="2"/><path d="M11 3v12"/></svg></button></div></div>
    <div className="diff-workspace">
      <div ref={scroll} className="diff-code-scroll" aria-busy={loading||refreshing} onScroll={() => {
        const root = scroll.current; if (!root) return;
        const sections = [...root.querySelectorAll<HTMLElement>('[data-diff-file]')];
        const top = root.getBoundingClientRect().top;
        const visible = sections.find(section => section.getBoundingClientRect().bottom > top + 40);
        if (visible) setActive(Number(visible.dataset.diffFile));
      }}>
        {(loading||refreshing) && <p className="diff-notice" role="status">{refreshing?'正在读取工作区变更…':'正在加载差异…'}</p>}
        {loadError&&<div className="diff-notice workspace-changes-error" role="alert"><p>{loadError}</p>{files.length>0&&<p>下方保留上次读取的变更，请刷新后再核对。</p>}</div>}
        {changes&&!files.length&&!loading&&!refreshing&&!loadError&&<div className="workspace-changes-empty" role="status"><strong>暂无变更</strong><p>工作区与当前提交一致。修改文件后，点击刷新查看。</p></div>}
        {error && <div className="diff-notice"><p role="alert">无法显示差异：{error}</p><pre>{patches.join('\n')}</pre></div>}
        {view === 'summary' && parsed && <div className="preview-summary diff-summary"><h3>变更摘要</h3><p>新增 {total.added} 行 · 删除 {total.removed} 行</p>{files.map((file, i) => <button key={i} onClick={() => locate(i)}><span>{file.name}{file.prevName && <small>原路径：{file.prevName}</small>}{file.change?.reason&&<small>{file.change.reason}</small>}</span>{file.data?<Counts {...counts(file)} />:<span className="review-note">{file.change?.editable?'无文本差异':'只读'}</span>}</button>)}</div>}
        <div ref={container} hidden={view === 'summary'}>{parsed && view !== 'summary' && files.map((file, index) => <section key={`${index}:${file.name}`} data-diff-file={index} tabIndex={-1} aria-label={file.name}>{file.data?<ReviewDiffFile library={parsed.library} file={file.data} view={view} theme={theme} client={review} editable={file.change?.editable} readOnlyReason={file.change?.reason}/>:<ReviewFileNotice name={file.name} reason={file.change?.reason||'没有可显示的文本差异。'} editable={Boolean(file.change?.editable)} client={review}/>}</section>)}</div>
      </div>
      {filesOpen && <nav id="diff-file-list" className="diff-file-list" aria-label="已更改的文件"><div className="diff-file-search"><input aria-label="筛选文件" placeholder="筛选文件…" value={query} onChange={e => setQuery(e.target.value)} /></div><div className="diff-file-tree"><p>已更改的文件 <span>{files.length}</span></p>{groups.map(([directory, entries]) => <details key={directory} open><summary>{directory}</summary>{entries.map(({ file, index }) => <button key={index} aria-current={active === index ? 'true' : undefined} title={file.prevName ? `${file.prevName} → ${file.name}` : file.name} onClick={() => locate(index)}><span className="diff-file-name">{file.name.split('/').at(-1)}</span>{file.data?<Counts {...counts(file)} />:<span className="review-note">{file.change?.editable?'无文本差异':'只读'}</span>}</button>)}</details>)}{!groups.length && !loading && <p className="diff-no-files">{query ? '没有匹配的文件' : '暂无文件'}</p>}</div></nav>}
    </div>
  </aside>;
}
