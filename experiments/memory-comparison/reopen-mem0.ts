import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {embeddingServer} from './embeddings.ts';
process.env.MEM0_TELEMETRY='false';
const semantic=process.argv[2]==='semantic';
const previous=JSON.parse(await readFile(semantic?'results/mem0.json':'results/mem0-lexical.json','utf8'));
if(previous.setup?.status==='blocked'||!previous.dataDirectory)throw new Error('Complete the selected Mem0 comparison first');
if(semantic&&previous.embedding?.mode!=='semantic')throw new Error('Expected a semantic comparison');
const report:any={at:new Date().toISOString(),sourceRunAt:previous.runAt,freshProcess:true,networkInference:false,limitations:[]};
if(semantic)delete process.env.MEMORY_EMBEDDING_MODE;
const embedding=semantic?await embeddingServer(report):undefined;
try{
const {Memory}=await import('mem0ai/oss');
// A fresh process, no embedding or LLM request: getAll reads persisted vectors/payloads.
const memory=new Memory({
  llm:{provider:'openai',config:{apiKey:'unused',model:'unused',baseURL:'http://127.0.0.1:1'}},
  embedder:{provider:'openai',config:{apiKey:'unused',model:previous.embedding.model,baseURL:embedding?.url||'http://127.0.0.1:1',embeddingDims:384}},
  vectorStore:{provider:'memory',config:{collectionName:'comparison',dimension:384,dbPath:resolve(previous.dataDirectory,'vectors.db')}},
  historyDbPath:resolve(previous.dataDirectory,'history.db')
});
const result:any=await memory.getAll({filters:{user_id:'room:alpha'},topK:10});
const rows=Array.isArray(result)?result:result.results;
const pass=rows.some((x:any)=>x.metadata?.id==='decision'&&x.metadata?.source==='fixture://room-a/message-2#v1');
Object.assign(report,{status:pass?'pass':'fail',results:rows});
if(semantic){
  // Diagnose the failed fixed query without re-extracting or changing the main run's threshold.
  const query='storage technology selection';
  report.thresholdProbe={query,defaultThreshold:0.1,
    defaultResults:await memory.search(query,{filters:{user_id:'room:alpha'},topK:5}),
    zeroThresholdResults:await memory.search(query,{filters:{user_id:'room:alpha'},topK:5,threshold:0})};
}
await writeFile(semantic?'results/mem0-semantic-reopen.json':'results/mem0-reopen.json',JSON.stringify(report,null,2)+'\n');
console.log('Fresh-process persistent Mem0 read:',pass?'PASS':'FAIL');process.exitCode=pass?0:1;
}finally{await embedding?.close();}
