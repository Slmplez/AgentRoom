import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import type { FileDiffMetadata, DiffLineAnnotation } from '@pierre/diffs';
import type { z } from 'zod';
import type { reviewCommentSchema } from '../../contracts/file-review.mjs';
import { reviewHashText, createFileReviewClient } from '../client/file-review.mjs';
import { createAutosaveDocument } from '../client/file-autosave.mjs';
export type ReviewClient = ReturnType<typeof createFileReviewClient>;
type Comment = z.infer<typeof reviewCommentSchema>;
type Anchor = { side:'additions'|'deletions'; line:number };
const anchorKey = (a:Anchor) => `${a.side}:${a.line}`;
function FileEditor({client,file,close}:{client:ReviewClient;file:string;close():void}) {
 const model=useMemo(()=>createAutosaveDocument({client,file}),[client,file]);
 const state=useSyncExternalStore(model.subscribe,model.read);
 useEffect(()=>{void model.open();return()=>model.close();},[model]);
 const labels:Record<string,string>={loading:'读取文件…',saved:client.simulated?'已保存到模拟文件':'已自动保存',dirty:'等待自动保存',saving:'正在保存…',conflict:'磁盘文件已变化',error:'尚未保存'};
 return <section className="review-editor" aria-label={`编辑 ${file}`}>
  <div className="review-editor-toolbar"><span role="status">{labels[state.status]}</span><button onClick={()=>{void model.flush();close();}}>返回差异</button></div>
  {client.simulated && <p className="review-note">模拟文件 · 保存到此浏览器，不修改真实磁盘。</p>}
  <textarea aria-label={`文件内容 ${file}`} spellCheck={false} autoCapitalize="off" autoCorrect="off" readOnly={!state.ready} value={state.text} onChange={e=>model.update(e.target.value)} onCompositionStart={()=>model.composition(true)} onCompositionEnd={()=>model.composition(false)} onBlur={()=>void model.flush()} onKeyDown={e=>{if((e.ctrlKey||e.metaKey)&&e.key==='s'){e.preventDefault();void model.flush();}if(e.key==='Escape')e.stopPropagation();}} />
  {state.error&&<div className="review-error" role="alert"><p>{state.error}</p>{state.status!=='conflict'&&<button onClick={()=>void model.retry()}>重试保存</button>}</div>}
  {state.status==='conflict'&&<div className="review-conflict"><p>你的编辑已保留，自动保存已暂停。</p><details><summary>比较磁盘上的最新内容</summary><pre>{state.disk?.text||'磁盘内容暂不可用'}</pre></details><button onClick={()=>void model.useDisk()}>采用磁盘版本，并备份我的草稿</button></div>}
 </section>;
}
function CommentDraft({client,file,version,anchor,quote,onSaved,cancel}:{client:ReviewClient;file:string;version:string;anchor:Anchor;quote:string;onSaved(comment:Comment):void;cancel():void}) {
 const key=`${client.draftPrefix}:comment-draft:${file}:${version}:${anchorKey(anchor)}`;
 const [initial]=useState(()=>{try{const raw=localStorage.getItem(key);return raw?JSON.parse(raw):{text:'',pending:null};}catch{return {text:'',pending:null};}});
 const [text,setText]=useState<string>(initial.text),[busy,setBusy]=useState(false),[error,setError]=useState(initial.pending?'上次评论保存未确认，请重试核查。':'');
 const pending=useRef<Record<string,unknown>|null>(initial.pending);
 return <form className="review-comment-draft" onSubmit={async e=>{e.preventDefault();if(busy||!text.trim())return;setBusy(true);setError('');try{
  if(!pending.current)pending.current={type:'addComment',key:crypto.randomUUID(),file,version,...anchor,quote,text};
  localStorage.setItem(key,JSON.stringify({text,pending:pending.current}));
  const result=await client.request(pending.current);if(result.type!=='comment')throw Error('评论响应不正确。');
  localStorage.removeItem(key);onSaved(result.comment);
 }catch(e){setError((e as Error).message);}finally{setBusy(false);}}}>
  <header><strong className="review-comment-author"><span aria-hidden="true">你</span>行内评论</strong><span className="review-comment-location">{anchor.side==='additions'?'R':'L'}{anchor.line} · 仅本地可见</span></header>
  <textarea autoFocus aria-label="添加行内评论" placeholder="添加一条评论…" maxLength={4000} value={text} disabled={busy||Boolean(pending.current&&error)} onChange={e=>{setText(e.target.value);try{localStorage.setItem(key,JSON.stringify({text:e.target.value,pending:null}));}catch{setError('草稿无法写入本地存储，请保留页面。');}}} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();cancel();}}}/>
  {error&&<p role="alert">{error}</p>}<footer><span className="review-comment-draft-note">草稿自动保留</span><button type="button" disabled={busy} onClick={cancel}>取消</button><button type="submit" disabled={busy||!text.trim()}>{busy?'保存中…':error?'重试评论':'评论'}</button></footer>
 </form>;
}
export function ReviewFileNotice({name,reason,editable,client}:{name:string;reason:string;editable:boolean;client?:ReviewClient}) {
 const [editing,setEditing]=useState(false);
 useEffect(()=>{if(!editable)setEditing(false);},[editable]);
 return <><div className="review-file-toolbar"><strong>{name}</strong>{editable&&client&&!editing&&<button onClick={()=>setEditing(true)}>编辑文件</button>}<span>{editable?'无文本差异':'只读'}</span></div>{editing&&client?<FileEditor client={client} file={name} close={()=>setEditing(false)}/>:<p className="review-file-reason">{reason}</p>}</>;
}
export function ReviewDiffFile({library,file,view,theme,client,editable=true,readOnlyReason}:{library:typeof import('@pierre/diffs');file:FileDiffMetadata;view:'unified'|'split';theme:string;client?:ReviewClient;editable?:boolean;readOnlyReason?:string}) {
 const container=useRef<HTMLDivElement>(null);
 const [version,setVersion]=useState(''),[comments,setComments]=useState<Comment[]>([]),[anchor,setAnchor]=useState<Anchor|null>(null),[error,setError]=useState(''),[editing,setEditing]=useState(false);
 const [portals,setPortals]=useState<{key:string;host:HTMLElement;anchor:Anchor}[]>([]);
 const [line,setLine]=useState('1'),[side,setSide]=useState<Anchor['side']>('additions');
 useEffect(()=>{if(!editable)setEditing(false);},[editable]);
 useEffect(()=>{let alive=true;setComments([]);setAnchor(null);setVersion('');setError('');void reviewHashText(JSON.stringify({name:file.name,old:file.prevName,hunks:file.hunks,oldLines:file.deletionLines,newLines:file.additionLines})).then(async digest=>{
  if(!alive)return;setVersion(digest);if(!client)return;
  try{await client.seedFile(file.name,file.additionLines.join(''));const result=await client.request({type:'comments',file:file.name,version:digest});if(alive&&result.type==='comments'&&result.comments.length)setComments(result.comments);}catch(e){if(alive)setError((e as Error).message);}
 });return()=>{alive=false;};},[client,file]);
 const anchors=useMemo(()=>[...new Map([...comments.map(c=>({side:c.side,line:c.line})),...(anchor?[anchor]:[])].map(a=>[anchorKey(a),a])).values()] as Anchor[],[comments,anchor]);
 useEffect(()=>{
  if(editing)return;let alive=true;let hovered:Anchor|null=null;const host=container.current!;host.replaceChildren();setPortals([]);
  const element=document.createElement('diffs-container');host.append(element);
  const annotations:DiffLineAnnotation<Anchor>[]=anchors.map(a=>({side:a.side,lineNumber:a.line,metadata:a}));
  const instance=new library.FileDiff<Anchor>({unsafeCSS:':host { --diffs-font-family: var(--font-mono); --diffs-font-size: var(--font-size-code); }',diffStyle:view,theme:{light:'pierre-light',dark:'pierre-dark'},themeType:theme==='dark'?'dark':'light',preferredHighlighter:'shiki-js',overflow:'scroll',disableErrorHandling:true,
   enableGutterUtility:Boolean(client&&version),
   onLineEnter:row=>{hovered={side:row.annotationSide,line:row.lineNumber};},
   renderGutterUtility:getRow=>{if(!client||!version)return null;const button=document.createElement('button');button.type='button';button.className='review-gutter-add';button.setAttribute('aria-label','添加行内评论');button.title='添加行内评论';button.textContent='+';button.onclick=event=>{event.stopPropagation();const row=getRow();const selected=row?{side:row.side,line:row.lineNumber}:hovered;if(selected)setAnchor(selected);};return button;},
   renderAnnotation:annotation=>{const node=document.createElement('div'),a=annotation.metadata;queueMicrotask(()=>{if(alive)setPortals(old=>[...old.filter(p=>p.key!==anchorKey(a)),{key:anchorKey(a),host:node,anchor:a}]);});return node;},
  });
  try{instance.render({fileDiff:file,fileContainer:element,lineAnnotations:annotations});}catch(e){setError((e as Error).message);}
  return()=>{alive=false;instance.cleanUp();host.replaceChildren();};
 },[library,file,view,theme,anchors,editing,client,version]);
 return <>
  {client&&<div className="review-file-toolbar"><strong>{file.name}</strong>{!editing&&editable&&<button onClick={()=>setEditing(true)}>编辑文件</button>}{!editing&&<details><summary>添加评论</summary><form onSubmit={e=>{e.preventDefault();const n=Number(line);if(Number.isInteger(n)&&file.hunks.some(h=>side==='additions'?n>=h.additionStart&&n<h.additionStart+h.additionCount:n>=h.deletionStart&&n<h.deletionStart+h.deletionCount)){setError('');setAnchor({side,line:n});e.currentTarget.closest('details')!.open=false;}else setError('此行不在当前补丁展示的范围内。');}}><select aria-label="评论侧" value={side} onChange={e=>setSide(e.target.value as Anchor['side'])}><option value="additions">修改后 R</option><option value="deletions">修改前 L</option></select><input aria-label="评论行号" type="number" min="1" max="1000000" value={line} onChange={e=>setLine(e.target.value)}/><button disabled={!version}>添加</button></form></details>}<span>{!editable?'只读 · ':''}{comments.length?`${comments.length} 条评论 · 原始差异`:'原始差异 · 点击行旁 ＋ 评论'}</span></div>}
  {!editable&&readOnlyReason&&<p className="review-file-reason">{readOnlyReason}</p>}
  {error&&<p className="review-error" role="alert">{error}</p>}
  {editing&&client?<FileEditor client={client} file={file.name} close={()=>setEditing(false)}/>:<div ref={container}/>}
  {client&&portals.map(portal=>createPortal(<div className="review-comment-thread">{comments.filter(c=>anchorKey(c)===portal.key).map(comment=><article key={comment.id}><header><strong>{comment.authorName}</strong><span>{comment.side==='additions'?'R':'L'}{comment.line} · 本地评论</span></header><p>{comment.text}</p></article>)}{anchor&&anchorKey(anchor)===portal.key?<CommentDraft key={portal.key} client={client} file={file.name} version={version} anchor={anchor} quote={file.hunks.flatMap(h=>{const start=anchor.side==='additions'?h.additionStart:h.deletionStart,count=anchor.side==='additions'?h.additionCount:h.deletionCount,offset=anchor.side==='additions'?h.additionLineIndex:h.deletionLineIndex;return anchor.line>=start&&anchor.line<start+count?[(anchor.side==='additions'?file.additionLines:file.deletionLines)[offset+anchor.line-start]||'']:[]}).join('').slice(0,1000)} cancel={()=>{setAnchor(null);container.current?.parentElement?.querySelector<HTMLElement>('.review-file-toolbar summary')?.focus();}} onSaved={comment=>{setComments(old=>[...old.filter(c=>c.id!==comment.id),comment]);setAnchor(null);container.current?.parentElement?.querySelector<HTMLElement>('.review-file-toolbar summary')?.focus();}}/>:<button onClick={()=>setAnchor(portal.anchor)}>添加评论</button>}</div>,portal.host,portal.key))}
 </>;
}
