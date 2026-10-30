import {readFile,writeFile} from 'node:fs/promises';
import {embeddingServer} from './embeddings.ts';
import {decisionText,distractorTexts,retrievalQueries} from './fixtures.ts';

delete process.env.MEMORY_EMBEDDING_MODE;
const report:any={at:new Date().toISOString(),kind:'embedding-only-control',syntheticDataOnly:true,limitations:['Exact cosine ranking over four records, not a persistent database or production backend.','No LLM extraction in the original-text control. Extracted-text control reuses the prior real Mem0 run.','Small targeted query set; no held-out statistical evaluation.']};
const server=await embeddingServer(report);
try{
  const original=[{id:'decision',text:decisionText},...distractorTexts.map((text,i)=>({id:'distractor-'+i,text}))];
  const previous=JSON.parse(await readFile('results/mem0-semantic-reopen.json','utf8'));
  const extracted=previous.results.map((x:any)=>({id:x.metadata.id,text:x.memory}));
  report.sourceRunAt=previous.sourceRunAt;
  const queries=[...retrievalQueries,['我们用什么来持久化数据？','decision'],['storage technology selection','decision']];
  async function vectors(texts:string[]){
    const response=await fetch(server.url+'/embeddings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:texts})});
    if(!response.ok)throw new Error('Local embedding failed');
    const result:any=await response.json();return result.data.map((x:any)=>x.embedding as number[]);
  }
  const queryVectors=await vectors(queries.map(x=>x[0]));
  for(const [name,records] of [['original',original],['extracted',extracted]] as const){
    const recordVectors=await vectors(records.map((x:any)=>x.text));
    const evidence=queries.map(([query,expectedId],i)=>{
      const hits=records.map((record:any,j:number)=>({...record,score:queryVectors[i].reduce((sum:number,x:number,k:number)=>sum+x*recordVectors[j][k],0)})).sort((a:any,b:any)=>b.score-a.score);
      return {query,expectedId,correct:hits[0]?.id===expectedId,hits};
    });
    report[name]={gridTop1:evidence.slice(0,8).filter(x=>x.correct).length,gridTotal:8,allTop1:evidence.filter(x=>x.correct).length,allTotal:10,queries:evidence};
  }
  await writeFile('results/embedding-control.json',JSON.stringify(report,null,2)+'\n');
  console.log('Embedding control:',JSON.stringify({original:report.original.allTop1,extracted:report.extracted.allTop1,total:10}));
}finally{await server.close();}
