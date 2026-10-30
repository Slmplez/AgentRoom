import {readFile,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
process.env.MEM0_TELEMETRY='false';
const previous=JSON.parse(await readFile('results/mem0-lexical.json','utf8'));
if(!previous.dataDirectory)throw new Error('Re-run lexical Mem0 comparison first');
const {Memory}=await import('mem0ai/oss');
// A fresh process, no embedding or LLM request: getAll reads persisted vectors/payloads.
const memory=new Memory({
  llm:{provider:'openai',config:{apiKey:'unused',model:'unused',baseURL:'http://127.0.0.1:1'}},
  embedder:{provider:'openai',config:{apiKey:'unused',model:'unused',baseURL:'http://127.0.0.1:1'}},
  vectorStore:{provider:'memory',config:{collectionName:'comparison',dimension:384,dbPath:resolve(previous.dataDirectory,'vectors.db')}},
  historyDbPath:resolve(previous.dataDirectory,'history.db')
});
const result:any=await memory.getAll({filters:{user_id:'room:alpha'},topK:10});
const rows=Array.isArray(result)?result:result.results;
const pass=rows.some((x:any)=>x.metadata?.id==='decision'&&x.metadata?.source==='fixture://room-a/message-2#v1');
await writeFile('results/mem0-reopen.json',JSON.stringify({at:new Date().toISOString(),status:pass?'pass':'fail',freshProcess:true,networkInference:false,results:rows},null,2)+'\n');
console.log('Fresh-process persistent Mem0 read:',pass?'PASS':'FAIL');process.exitCode=pass?0:1;
