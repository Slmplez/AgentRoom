import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { reviewRequestSchema, reviewResultSchema, reviewFailure as fail } from '../../contracts/file-review.mjs';
export const contentHash = text => createHash('sha256').update(text).digest('hex');
const limit = 262144;
const decode = bytes => { try { const text = new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes); if(text.includes('\0'))throw Error(); return text; } catch { throw fail('unsupported_file','只支持 UTF-8 文本文件。'); } };
// Root and identity are supplied by a trusted host resolver, never by request bodies.
export function createFileReviewService({ directory, resolveScope, fault = () => {} }) {
 fs.mkdirSync(directory,{recursive:true});
 const db = new DatabaseSync(path.join(directory,'file-review.sqlite'));
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS comments(id TEXT PRIMARY KEY, scope TEXT NOT NULL, file TEXT NOT NULL, version TEXT NOT NULL, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS operations(actor TEXT NOT NULL, key TEXT NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL, data TEXT NOT NULL, result TEXT, PRIMARY KEY(actor,key));`);
 function target(root,file) {
  if(!root || !path.isAbsolute(root))throw fail('editing_unavailable','宿主未启用此工作区的文件编辑。');
  const realRoot=fs.realpathSync(root), dest=path.resolve(realRoot,...file.split('/'));
  const relative=path.relative(realRoot,dest);
  if(!relative || relative.startsWith('..'+path.sep) || path.isAbsolute(relative))throw fail('invalid_path','文件不在当前工作区内。');
  let current=realRoot;
  for(const part of file.split('/')) {
   current=path.join(current,part);const stat=fs.lstatSync(current);
   if(stat.isSymbolicLink() || fs.realpathSync(current)!==current)throw fail('invalid_path','不允许通过链接或重解析路径读写文件。');
  }
  const stat=fs.statSync(dest);
  if(!stat.isFile() || stat.nlink!==1)throw fail('unsupported_file','只允许编辑普通文件，不支持硬链接。');
  if(stat.size>limit)throw fail('file_too_large','文件超过 256 KB，无法在此编辑。');
  const rootStat=fs.statSync(realRoot);
  return {dest,rootId:contentHash(`${realRoot}\0${rootStat.dev}\0${rootStat.ino}`),stat};
 }
 function read(root,file) {
  const t=target(root,file),fd=fs.openSync(t.dest,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW||0));
  try {
   const stat=fs.fstatSync(fd);
   if(!stat.isFile()||stat.nlink!==1||stat.ino!==t.stat.ino||stat.dev!==t.stat.dev)throw fail('file_conflict','文件身份已变化，请重新读取。');
   const buffer=Buffer.alloc(limit+1);let size=0,count;
   do{count=fs.readSync(fd,buffer,size,buffer.length-size,null);size+=count;}while(count&&size<buffer.length);
   if(size>limit)throw fail('file_too_large','文件超过 256 KB。');
   const bytes=buffer.subarray(0,size);return {...t,text:decode(bytes),revision:contentHash(bytes)};
  }finally{fs.closeSync(fd);}
 }
 const transaction = action => {db.exec('BEGIN IMMEDIATE');try{const result=action();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
 function request(raw,caller) {
  const parsed=reviewRequestSchema.safeParse(raw);if(!parsed.success)throw fail('invalid_request','请求不符合文件审阅契约。');
  const input=parsed.data, scope=resolveScope(input,caller);
  if(!scope || !scope.authorId || scope.workspaceId!==input.workspaceId || scope.roomId!==input.roomId)throw fail('forbidden','当前身份无权访问此工作区或房间。');
  const scopeKey=JSON.stringify([scope.workspaceId,scope.roomId,scope.authorId]);
  const common={workspaceId:input.workspaceId,roomId:input.roomId,file:input.file,simulated:false};
  try {
   if(input.type==='readFile'){const file=read(scope.root,input.file);return reviewResultSchema.parse({type:'file',...common,rootId:file.rootId,revision:file.revision,text:file.text});}
   if(input.type==='comments')return {type:'comments',...common,version:input.version,comments:db.prepare('SELECT data FROM comments WHERE scope=? AND file=? AND version=? ORDER BY rowid').all(scopeKey,input.file,input.version).map(r=>JSON.parse(r.data))};
   const digest=contentHash(JSON.stringify(input)), actor=scopeKey;
   let previous=db.prepare('SELECT * FROM operations WHERE actor=? AND key=?').get(actor,input.key);
   if(previous && previous.digest!==digest)throw fail('idempotency_conflict','该保存标识已用于其他内容。');
   if(previous?.state==='complete')return JSON.parse(previous.result);
   if(input.type==='addComment')return transaction(()=>{
    previous=db.prepare('SELECT * FROM operations WHERE actor=? AND key=?').get(actor,input.key);
    if(previous){if(previous.digest!==digest)throw fail('idempotency_conflict','评论标识已用于其他内容。');return JSON.parse(previous.result);}
    if(db.prepare('SELECT COUNT(*) AS n FROM comments WHERE scope=? AND file=? AND version=?').get(scopeKey,input.file,input.version).n>=500)throw fail('too_many_comments','此文件版本已达到 500 条评论上限。');
    const comment={id:randomUUID(),authorId:scope.authorId,authorName:scope.authorName||'你',version:input.version,side:input.side,line:input.line,quote:input.quote,text:input.text,createdAt:new Date().toISOString()};
    const result={type:'comment',...common,key:input.key,comment};
    db.prepare('INSERT INTO comments VALUES(?,?,?,?,?)').run(comment.id,scopeKey,input.file,input.version,JSON.stringify(comment));
    db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(actor,input.key,digest,'complete','{}',JSON.stringify(result));return result;
   });
   if(scope.canWrite!==true)throw fail('editing_unavailable','当前工作区未开启文件写入。');
   const bytes=Buffer.from(input.text,'utf8');if(bytes.length>limit || input.text.includes('\0') || decode(bytes)!==input.text)throw fail('unsupported_file','内容必须为 256 KB 以内的有效 UTF-8 文本。');
   const nextRevision=contentHash(bytes);
   // Keep the prepared draft before touching the filesystem. Recovery never blindly replays it.
   if(!previous)transaction(()=>{
    const current=read(scope.root,input.file);
    if(current.rootId!==input.rootId || current.revision!==input.expectedRevision)throw fail('file_conflict','文件已被外部修改；草稿已保留，请先比较磁盘内容。');
    db.prepare('INSERT INTO operations VALUES(?,?,?,?,?,NULL)').run(actor,input.key,digest,'prepared',JSON.stringify({rootId:current.rootId,file:input.file,previous:current.text,next:input.text}));
   });
   fault('prepared');
   return transaction(()=>{
    const current=read(scope.root,input.file);
    if(current.rootId!==input.rootId)throw fail('file_conflict','工作区目录已变化，已停止自动保存。');
    if(current.revision!==nextRevision){
     if(current.revision!==input.expectedRevision)throw fail('file_conflict','文件已被外部修改；草稿已保留，请先比较磁盘内容。');
     const temporary=path.join(path.dirname(current.dest),`.agentroom-${randomUUID()}.tmp`);
     try {
      const fd=fs.openSync(temporary,'wx',current.stat.mode & 0o777);
      try{fs.writeFileSync(fd,bytes);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
      fault('before_replace');
      const check=read(scope.root,input.file);
      if(check.rootId!==input.rootId || check.revision!==input.expectedRevision || check.stat.ino!==current.stat.ino)throw fail('file_conflict','磁盘文件已变化，已停止覆盖。');
      fs.renameSync(temporary,current.dest);
      // Directory fsync is supported on POSIX; Windows rename guarantees differ.
      if(process.platform!=='win32'){const dir=fs.openSync(path.dirname(current.dest),'r');try{fs.fsyncSync(dir);}finally{fs.closeSync(dir);}}
      fault('replaced');
     }finally{
      // Do not follow a directory swapped for a link during failure cleanup.
      try { const safe=target(scope.root,input.file); if(safe.dest===current.dest&&safe.rootId===input.rootId)fs.unlinkSync(temporary); } catch(e) { if(e.code!=='ENOENT'&&!e.outcome)throw e; }
     }
    }
    const result={type:'saved',...common,key:input.key,rootId:input.rootId,revision:nextRevision};
    db.prepare("UPDATE operations SET state=?,result=?,data='{}' WHERE actor=? AND key=?").run('complete',JSON.stringify(result),actor,input.key);
    return result;
   });
  }catch(e){if(e.outcome)throw e;if(e.code==='ENOENT')throw fail('file_missing','文件不存在或已被移走，草稿仍保留。');throw fail('review_io_error','读写未完成；草稿已保留，请重试并核查磁盘内容。',input.type==='saveFile'?'unknown':'rejected');}
 }
 return {request,close:()=>db.close()};
}
