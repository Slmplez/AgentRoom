import {mkdir,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
const report:any={at:new Date().toISOString(),node:process.version,platform:process.platform,checks:[]};
for(const name of ['mem0ai/oss','@vectorize-io/hindsight-client','@huggingface/transformers']){
  try{await import(name);report.checks.push({name,status:'importable'});}catch(e:any){report.checks.push({name,status:'blocked',reason:e.message});}
}
const p=spawnSync(resolve('.venv/Scripts/python.exe'),['-c','import hindsight_api; print("hindsight_api importable")'],{encoding:'utf8',windowsHide:true,timeout:10000});
report.checks.push({name:'hindsight-api-slim',status:p.status===0?'importable':'blocked',reason:p.error?.message||p.stderr||p.stdout});
const start=Date.now();
try{
  const r=await fetch('https://registry.npmjs.org/better-sqlite3/12.6.2',{signal:AbortSignal.timeout(10000)});const j=await r.json();
  const artifact=await fetch(j.dist.tarball,{signal:AbortSignal.timeout(20000)});const bytes=(await artifact.arrayBuffer()).byteLength;
  report.checks.push({name:'better-sqlite3 artifact download',status:artifact.ok?'downloaded':'blocked',httpStatus:artifact.status,bytes,ms:Date.now()-start});
}catch(e:any){report.checks.push({name:'better-sqlite3 artifact download',status:'blocked',reason:e.name,ms:Date.now()-start});}
await mkdir('results',{recursive:true});await writeFile('results/preflight.json',JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
