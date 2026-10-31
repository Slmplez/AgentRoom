import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { reviewPath, reviewFailure as fail } from '../../contracts/file-review.mjs';

// Fixed commands only. No client paths, revisions, root or Git options are accepted.
export function readWorkspaceChanges(root, readFile) {
 if(!root || !path.isAbsolute(root))throw fail('editing_unavailable','宿主未启用编辑工作区。');
 const canonical=fs.realpathSync(root), stat=fs.statSync(canonical);
 const rootId=createHash('sha256').update(`${canonical}\0${stat.dev}\0${stat.ino}`).digest('hex');
 const deadline=Date.now()+10000, env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.toUpperCase().startsWith('GIT_')));
 Object.assign(env,{GIT_OPTIONAL_LOCKS:'0',GIT_TERMINAL_PROMPT:'0',GIT_ATTR_NOSYSTEM:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:process.platform==='win32'?'NUL':'/dev/null'});
 const filterOverrides=[];
 function git(args,{accepted=[0],maxBuffer=1048576}={}) {
  if(Date.now()>=deadline)throw fail('changes_timeout','读取变更超时，请缩小工作区后重试。');
  const options={cwd:canonical,env,windowsHide:true,encoding:'buffer',stdio:['pipe','pipe','pipe'],timeout:Math.min(3000,deadline-Date.now()),maxBuffer,input:Buffer.alloc(0)};
  try{return execFileSync('git',['--no-pager','--literal-pathspecs','-c','core.fsmonitor=false','-c','core.quotePath=false','-c','color.ui=false','-c','status.renames=false',...filterOverrides,...args],options);}
  catch(error){
   if(accepted.includes(error.status))return error.stdout||Buffer.alloc(0);
   if(error.code==='ENOENT')throw fail('git_unavailable','未找到 Git，请在宿主安装 Git 后重试。');
   if(error.code==='ENOBUFS')throw fail('changes_too_large','变更超过读取上限，未返回截断差异。');
   if(error.code==='ETIMEDOUT')throw fail('changes_timeout','读取变更超时，请稍后重试。');
   throw fail('git_read_failed','无法读取 Git 变更，请检查工作区仓库状态。');
  }
 }
 const text=bytes=>{try{return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw fail('unsupported_diff','差异包含非 UTF-8 内容，未返回截断差异。');}};
 const top=text(git(['rev-parse','--show-toplevel'])).trim();
 if(fs.realpathSync(top)!==canonical)throw fail('invalid_repository','编辑工作区必须是 Git 仓库根目录。');
 // Git may run clean/process filters even for read-only diff/status. Disable repository filters.
 const filterKeys=text(git(['config','--name-only','--get-regexp','^filter\\..*\\.(clean|process|required)$'],{accepted:[0,1],maxBuffer:65536})).trim().split(/\r?\n/).filter(Boolean);
 for(const key of filterKeys){
  if(!/^filter\.[^\r\n=]+\.(clean|process|required)$/i.test(key))throw fail('git_read_failed','Git 过滤器配置无法安全读取。');
  filterOverrides.push('-c',`${key}=${/\.required$/i.test(key)?'false':''}`);
 }
 const base=text(git(['rev-parse','--verify','--quiet','HEAD'],{accepted:[0,1]})).trim();
 if(base&&!/^[a-f0-9]{40,64}$/.test(base))throw fail('git_read_failed','Git 基准版本无效。');
 const statusArgs=['status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=all'];
 const status=git(statusArgs,{maxBuffer:65536});
 const entries=text(status).split('\0').filter(Boolean);
 if(entries.length>60)throw fail('too_many_changes','变更超过 60 个文件，未返回部分文件列表。');
 const files=[];let bytes=0;
 for(const entry of entries){
  const file=entry.slice(3),state=entry.slice(0,2);
  const item={file,status:state,patch:null,editable:false};
  if(!reviewPath.safeParse(file).success||/[\r\n\t]/.test(file)){files.push({...item,reason:'路径不支持安全审阅。'});continue;}
  if(state.includes('U')||['AA','DD'].includes(state)){files.push({...item,reason:'文件存在 Git 合并冲突，请先在工作区解决。'});continue;}
  let missing=false;
  try{readFile(root,file);item.editable=true;}
  catch(error){
   if(error.code==='ENOENT'||error.code==='file_missing'){missing=true;item.reason='文件已删除，仅可查看原始差异。';}
   else {files.push({...item,reason:error.outcome?error.message:'文件无法安全读取，仅显示状态。'});continue;}
  }
  if((!base||state==='??')&&missing){files.push({...item,reason:'文件已移走，请刷新变更。'});continue;}
  const args=['diff','--no-ext-diff','--no-textconv','--no-color','--no-renames','--src-prefix=a/','--dst-prefix=b/','--unified=3'];
  // no-index includes untracked files and files in an unborn repository; exit 1 means differences.
  const patch=text(git(!base||state==='??'?[...args,'--no-index','--','/dev/null',file]:[...args,base,'--',file],{accepted:[0,1]}));
  if(!patch)continue;
  bytes+=Buffer.byteLength(patch);
  if(bytes>1048576)throw fail('changes_too_large','差异总量超过 1 MiB，未返回截断差异。');
  if(/^Binary files /m.test(patch)){item.editable=false;item.reason='二进制差异，仅可查看状态。';}
  files.push({...item,patch});
 }
 if(!status.equals(git(statusArgs,{maxBuffer:65536}))||base!==text(git(['rev-parse','--verify','--quiet','HEAD'],{accepted:[0,1]})).trim())throw fail('changes_changed','读取期间工作区状态已变化，请刷新重试。');
 return {rootId,base:base||'unborn',complete:true,files};
}
