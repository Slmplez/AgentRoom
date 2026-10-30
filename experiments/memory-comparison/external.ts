import { resolve } from 'node:path';
import { embeddingServer } from './embeddings.ts';
import type { Backend, Record, Hit } from './contracts.ts';

export async function externalBackend(kind:string,dir:string,report:any):Promise<Backend>{
  if(!['mem0','hindsight'].includes(kind))throw new Error('Unknown backend '+kind);
  if(!process.env.DEEPSEEK_API_KEY)throw new Error('Set DEEPSEEK_API_KEY for real extraction; no mock fallback.');
  report.model={provider:'DeepSeek',model:process.env.MEMORY_MODEL||'deepseek-flash',usage:'Token usage not collected; latency only.'};
  process.env.MEM0_TELEMETRY='false';
  const embedding=await embeddingServer(report);
  try {
    if(kind==='hindsight'){
      const {hindsightBackend}=await import('./hindsight.ts');
      return await hindsightBackend(dir,report,embedding);
    }
    const {Memory}=await import('mem0ai/oss');
    const memory=new Memory({
      llm:{provider:'openai',config:{apiKey:process.env.DEEPSEEK_API_KEY,baseURL:'https://api.deepseek.com',model:report.model.model,temperature:0,timeout:90000,maxTokens:2048}},
      embedder:{provider:'openai',config:{apiKey:'local-only',baseURL:embedding.url,model:report.embedding.model,embeddingDims:384}},
      vectorStore:{provider:'memory',config:{collectionName:'comparison',dimension:384,dbPath:resolve(dir,'vectors.db')}},
      historyDbPath:resolve(dir,'history.db')
    });
    const ids=new Map<string,string[]>();
    report.configuration={package:'mem0ai@3.3.1',vectorStore:'memory provider (SQLite-backed in installed 3.3.1)',extraction:true,telemetry:false,correction:'explicit update; automatic contradiction reconciliation not assumed'};
    return {
      name:'Mem0 OSS TypeScript 3.3.1',
      async put(record){
        const key=record.scope+'|'+record.id;
        const old=ids.get(key);
        if(old?.length){for(const id of old)await memory.update(id,{text:record.text,metadata:record});}
        else{
          const result:any=await memory.add([{role:'user',content:record.text}],{userId:record.scope,metadata:record});
          const items=result.results??result;
          ids.set(key,items.filter((x:any)=>x.id).map((x:any)=>x.id));
          if(!ids.get(key)?.length)throw new Error('Mem0 extracted no memory');
        }
      },
      async search(scope,query){const result:any=await memory.search(query,{filters:{user_id:scope},topK:5});return (result.results??result).map((x:any)=>({...x.metadata,text:x.memory,backendId:x.id,score:x.score}));},
      async forget(scope,id){for(const key of ids.get(scope+'|'+id)||[])await memory.delete(key);ids.delete(scope+'|'+id);},
      async history(scope,id){return (await Promise.all((ids.get(scope+'|'+id)||[]).map(key=>memory.history(key)))).flat();},
      async close(){await embedding.close();}
    };
  }catch(e){await embedding.close();throw e;}
}
