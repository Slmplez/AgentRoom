import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Backend } from './contracts.ts';
import { HindsightClient } from '@vectorize-io/hindsight-client';

async function freePort(){const s=createServer();await new Promise<void>(r=>s.listen(0,'127.0.0.1',r));const port=(s.address() as any).port;await new Promise<void>(r=>s.close(()=>r()));return port;}
export async function hindsightBackend(dir:string,report:any,embedding:{url:string,close:()=>Promise<void>}):Promise<Backend>{
  const prefix='comparison-'+randomUUID().slice(0,8);
  const port=await freePort();
  const baseUrl=process.env.HINDSIGHT_URL||`http://127.0.0.1:${port}`;
  const childEnv={...process.env,
    HINDSIGHT_API_HOST:'127.0.0.1',HINDSIGHT_API_PORT:String(port),
    HINDSIGHT_API_DATABASE_URL:`pg0://${prefix}`,
    HINDSIGHT_API_LLM_PROVIDER:'openai',HINDSIGHT_API_LLM_API_KEY:process.env.DEEPSEEK_API_KEY!,
    HINDSIGHT_API_LLM_MODEL:report.model.model,HINDSIGHT_API_LLM_BASE_URL:'https://api.deepseek.com',
    HINDSIGHT_API_EMBEDDINGS_PROVIDER:'openai',HINDSIGHT_API_EMBEDDINGS_OPENAI_API_KEY:'local-only',
    HINDSIGHT_API_EMBEDDINGS_OPENAI_MODEL:report.embedding.model,HINDSIGHT_API_EMBEDDINGS_OPENAI_BASE_URL:embedding.url,
    HINDSIGHT_API_RERANKER_PROVIDER:'rrf',HINDSIGHT_API_ENABLE_AUTO_CONSOLIDATION:'false',
    HINDSIGHT_API_LOG_LEVEL:'WARNING',PYTHONUTF8:'1'
  };
  let log='';let spawnError='';
  const child=process.env.HINDSIGHT_URL?null:spawn(resolve('.venv/Scripts/hindsight-api.exe'),[],{cwd:dir,env:childEnv,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child?.on('error',e=>{spawnError=e.message;});
  const redact=(s:string)=>s.replaceAll(process.env.DEEPSEEK_API_KEY||'__NO_KEY__','[REDACTED]');
  child?.stdout?.on('data',b=>{log=(log+redact(String(b))).slice(-20000);});
  child?.stderr?.on('data',b=>{log=(log+redact(String(b))).slice(-20000);});
  async function stop(){
    if(child&&child.exitCode===null){
      if(process.platform==='win32'&&child.pid){await new Promise<void>(r=>{const k=spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});k.on('exit',()=>r());k.on('error',()=>r());});}
      else child.kill('SIGTERM');
    }
    await writeFile(resolve(dir,'hindsight-startup.log'),log);await embedding.close();
  }
  try{
    const start=Date.now();let ready=false;
    while(Date.now()-start<180000){
      if(spawnError)throw new Error(spawnError);
      if(child&&child.exitCode!==null)throw new Error('Hindsight exited '+child.exitCode+'; '+log.slice(-2500));
      try{const r=await fetch(baseUrl+'/health',{signal:AbortSignal.timeout(2000)});if(r.ok){ready=true;break;}}catch{}
      await new Promise(r=>setTimeout(r,500));
    }
    if(!ready)throw new Error('Hindsight startup timeout; '+log.slice(-2500));
    const client=new HindsightClient({baseUrl});
    report.configuration={package:'@vectorize-io/hindsight-client@1.1.0',server:await client.getVersion(),reranker:'rrf',autoConsolidation:false,startupMs:Date.now()-start,externalServer:Boolean(process.env.HINDSIGHT_URL),bankPrefix:prefix};
    report.limitations.push('Hindsight uses synchronous retain, raw fact recall and no auto-consolidation. Observation/reflect correction propagation is not established by this run.');
    const bank=(scope:string)=>prefix+'-'+scope.replaceAll(':','-');
    const banks=new Set<string>();
    async function ensure(scope:string){if(!banks.has(scope)){await client.createBank(bank(scope),{name:scope});banks.add(scope);}}
    return {
      name:'Hindsight 1.1.0',
      async put(record){await ensure(record.scope);await client.retain(bank(record.scope),record.text,{documentId:record.id,metadata:{...record,revision:String(record.revision)},async:false,updateMode:'replace',signal:AbortSignal.timeout(120000)});},
      async search(scope,query){await ensure(scope);const response=await client.recall(bank(scope),query,{budget:'low',maxTokens:1500,includeChunks:true,types:['world','experience'],signal:AbortSignal.timeout(60000)});return response.results.map((x:any)=>({...x.metadata,id:x.document_id,text:x.text,revision:Number(x.metadata?.revision),backendId:x.id}));},
      async forget(scope,id){await client.deleteDocument(bank(scope),id);},
      async history(scope,id){const r=await client.getDocumentHistory(bank(scope),id);return r?.items||[];},
      async close(){await stop();}
    };
  }catch(e){await stop();throw e;}
}
