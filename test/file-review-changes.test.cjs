const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {execFileSync}=require('node:child_process');
async function fixture(t,{unborn=false}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'agentroom-git-review-')),root=path.join(dir,'repo');fs.mkdirSync(root);
 const git=(...args)=>execFileSync('git',args,{cwd:root,windowsHide:true,encoding:'utf8',stdio:['pipe','pipe','pipe']});
 git('init');git('config','user.name','Review Test');git('config','user.email','review@example.invalid');git('config','core.autocrlf','false');
 fs.writeFileSync(path.join(root,'file.txt'),'original\n');git('add','.');if(!unborn)git('commit','-m','initial');
 const {createFileReviewService}=await import('../lib/file-review/service.mjs');
 const service=createFileReviewService({directory:path.join(dir,'data'),resolveScope:(input,caller)=>caller==='human'?{workspaceId:'w',roomId:'r',authorId:'u',root,canWrite:true}:null});
 t.after(()=>{service.close();fs.rmSync(dir,{recursive:true,force:true});});
 const changes=(extra={},caller='human')=>service.request({type:'changes',workspaceId:'w',roomId:'r',...extra},caller);
 return {dir,root,git,changes,write:(file,text)=>fs.writeFileSync(path.join(root,file),text)};
}
test('real Git changes combine staged, unstaged and untracked files without writes',async t=>{
 const f=await fixture(t);assert.deepEqual(f.changes().files,[]);
 f.write('file.txt','staged\n');f.git('add','file.txt');f.write('file.txt','latest\n');f.write('新增 文件.txt','untracked\n');
 const before=f.git('status','--porcelain=v1');const result=f.changes();assert.equal(result.complete,true);assert.equal(result.files.length,2);
 assert.match(result.files.find(x=>x.file==='file.txt').patch,/-original\n\+latest/);assert.match(result.files.find(x=>x.file==='新增 文件.txt').patch,/\+untracked/);
 assert.ok(result.files.every(x=>x.editable));assert.equal(f.git('status','--porcelain=v1'),before);
 assert.throws(()=>f.changes({root:f.dir}),{code:'invalid_request'});assert.throws(()=>f.changes({},'other'),{code:'forbidden'});
});
test('unborn repositories expose complete added-file patches',async t=>{
 const f=await fixture(t,{unborn:true});f.write('second.txt','second\n');const result=f.changes();assert.equal(result.base,'unborn');assert.equal(result.files.length,2);assert.ok(result.files.every(x=>x.patch.includes('new file mode')));
});
test('Git treats bracket filenames literally instead of matching other paths',async t=>{
 const f=await fixture(t);f.write('[a].txt','bracket before\n');f.write('a.txt','plain before\n');f.git('add','.');f.git('commit','-m','paths');
 f.write('[a].txt','bracket after\n');f.write('a.txt','plain after\n');const result=f.changes();
 const patch=result.files.find(x=>x.file==='[a].txt').patch;assert.match(patch,/\+bracket after/);assert.doesNotMatch(patch,/plain after/);assert.equal((patch.match(/^diff --git/gm)||[]).length,1);
});
test('deleted, binary, oversize and link paths stay read-only',async t=>{
 const f=await fixture(t);fs.unlinkSync(path.join(f.root,'file.txt'));f.write('binary.bin',Buffer.from([0,255,2]));f.write('large.txt',Buffer.alloc(262145,65));
 const result=f.changes(),removed=result.files.find(x=>x.file==='file.txt');assert.equal(removed.editable,false);assert.match(removed.patch,/-original/);
 for(const file of ['binary.bin','large.txt']){const item=result.files.find(x=>x.file===file);assert.equal(item.editable,false);assert.equal(item.patch,null);assert.ok(item.reason);}
 fs.mkdirSync(path.join(f.dir,'outside'));fs.writeFileSync(path.join(f.dir,'outside','secret.txt'),'secret');fs.symlinkSync(path.join(f.dir,'outside'),path.join(f.root,'linked'),'junction');
 const linked=f.changes().files.filter(x=>x.file.startsWith('linked'));assert.ok(linked.every(x=>!x.editable&&x.patch===null));
});
test('file and aggregate patch limits reject whole response instead of truncation',async t=>{
 const f=await fixture(t);for(let i=0;i<61;i++)f.write(`extra-${i}.txt`,'x');assert.throws(()=>f.changes(),{code:'too_many_changes'});
 for(let i=0;i<61;i++)fs.unlinkSync(path.join(f.root,`extra-${i}.txt`));for(let i=0;i<6;i++)f.write(`large-${i}.txt`,'line of code here\n'.repeat(14000));assert.throws(()=>f.changes(),{code:'changes_too_large'});
});
test('Git diff never executes configured clean filters',async t=>{
 const f=await fixture(t);f.write('.gitattributes','*.txt filter=sentinel\n');f.git('config','filter.sentinel.clean','echo executed > filter-ran');f.git('config','filter.sentinel.required','true');f.write('file.txt','changed\n');
 assert.match(f.changes().files.find(x=>x.file==='file.txt').patch,/\+changed/);assert.equal(fs.existsSync(path.join(f.root,'filter-ran')),false);
});
test('missing Git and non-repository roots have explicit errors',async t=>{
 const f=await fixture(t),old=process.env.PATH;try{process.env.PATH='';assert.throws(()=>f.changes(),{code:'git_unavailable'});}finally{process.env.PATH=old;}
 fs.renameSync(path.join(f.root,'.git'),path.join(f.dir,'git-backup'));assert.throws(()=>f.changes(),{code:'git_read_failed'});
});
