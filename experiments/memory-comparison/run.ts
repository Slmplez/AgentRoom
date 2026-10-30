import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { sqliteBackend } from './sqlite.ts';
import { Souls } from './soul.ts';
import type { Backend, Record } from './contracts.ts';
import {decisionText,distractorTexts,retrievalQueries} from './fixtures.ts';

const kind=process.argv[2]||'sqlite';
const stamp=new Date().toISOString().replaceAll(':','-');
const dir=resolve('runtime',kind+'-'+stamp);
await mkdir(dir,{recursive:true});await mkdir('results',{recursive:true});
const report:any={kind,runAt:new Date().toISOString(),dataDirectory:dir,node:process.version,platform:process.platform,syntheticDataOnly:true,checks:[],timings:[],limitations:['Small functional comparison, not a statistical benchmark.','Scope checks exercise trusted application contexts, not production multi-user authentication.','Soul tests validate application state assembly, not model personality adherence.']};
let backend:Backend|undefined;
let souls:Souls|undefined;
async function check(name:string,layer:string,fn:()=>Promise<any>){
  const t=performance.now();
  try{const evidence=await fn();report.checks.push({name,layer,status:'pass',evidence,ms:Math.round(performance.now()-t)});console.log('PASS',name);}
  catch(e:any){report.checks.push({name,layer,status:'fail',error:String(e.message),ms:Math.round(performance.now()-t)});console.log('FAIL',name,e.message);}
}
function expect(ok:unknown,message:string){if(!ok)throw new Error(message);}
async function timed(name:string,fn:()=>Promise<any>){const t=performance.now();const r=await fn();report.timings.push({name,ms:Math.round(performance.now()-t)});return r;}
const pref:Record={id:'preference',scope:'agent:iris',text:'Iris prefers concise bullet lists. 鸢尾喜欢简洁的要点列表。',source:'fixture://room-a/message-1#v1',task:'task-1',revision:1};
const shared:Record={id:'decision',scope:'room:alpha',text:decisionText,source:'fixture://room-a/message-2#v1',task:'task-1',revision:1};
try{
  backend=kind==='sqlite'?sqliteBackend(resolve(dir,'memory.sqlite')):await (await import('./external.ts')).externalBackend(kind,dir,report);
  souls=new Souls(resolve(dir,'souls.sqlite'));
  const iris={agentId:'iris',name:'鸢尾',personality:'冷静、审慎，先核实证据。',expression:'简洁、直截了当。',workStyle:'先列风险，再给结论。',revision:1};
  const ember={agentId:'ember',name:'余烬',personality:'热情、好奇，乐于探索。',expression:'温暖、生动，善用比喻。',workStyle:'先提出可能性，再做小实验。',revision:1};
  souls.edit('human-owner',iris);souls.edit('human-owner',ember);
  await timed('write-preference',()=>backend!.put(pref));
  await timed('write-shared',()=>backend!.put(shared));
  for(const [i,text] of distractorTexts.entries()){
    await timed('write-distractor-'+i,()=>backend!.put({...shared,id:'distractor-'+i,text,source:`fixture://room-a/distractor-${i}#v1`}));
  }
  await check('cross-task-preference','backend',async()=>{const hits=await backend!.search('agent:iris','concise bullet lists');expect(hits.some(x=>x.id===pref.id),'Expected preference from task-1 while starting task-2');return hits;});
  await check('source-reference','backend',async()=>{const hits=await backend!.search('agent:iris','concise');expect(hits.some(x=>x.source===pref.source),'Missing original source reference');return hits.map(x=>({id:x.id,source:x.source}));});
  await check('private-scope','backend',async()=>{const hits=await backend!.search('agent:ember','concise bullet lists');expect(hits.length===0,'Private preference leaked across agent scopes');return hits;});
  await check('shared-knowledge-independent-souls','application',async()=>{const hits=await backend!.search('room:alpha','SQLite');expect(hits.some(x=>x.id===shared.id),'Missing shared decision');expect(souls!.get('iris')!.personality!==souls!.get('ember')!.personality,'Personalities collapsed');return {iris:souls!.get('iris'),ember:souls!.get('ember'),shared:hits};});
  await check('chinese-paraphrase','retrieval-quality',async()=>{const hits=await backend!.search('room:alpha','我们用什么来持久化数据？');expect(hits[0]?.id===shared.id,'Chinese paraphrase did not rank database decision first');return hits;});
  await check('semantic-top1-with-distractors','retrieval-quality',async()=>{const hits=await backend!.search('room:alpha','storage technology selection');expect(hits[0]?.id===shared.id,'Lexically different storage query did not rank database decision first');return hits;});
  await check('multilingual-query-grid','retrieval-quality',async()=>{
    // Fixed before the semantic run; do not tune queries against observed output.
    const evidence=[];
    for(const [query,expectedId] of retrievalQueries){
      const hits=await backend!.search('room:alpha',query);
      evidence.push({query,expectedId,correct:hits[0]?.id===expectedId,hits});
    }
    report.retrievalProbe={top1Correct:evidence.filter(x=>x.correct).length,total:evidence.length,queries:evidence};
    expect(evidence.every(x=>x.correct),`Top-1 ${report.retrievalProbe.top1Correct}/${evidence.length}; see retrievalProbe for every ranking`);
    return report.retrievalProbe;
  });
  await check('correction','backend',async()=>{await backend!.put({...pref,text:'Iris now prefers detailed paragraphs. 鸢尾现在偏好详细的段落解释。',source:'fixture://room-a/message-3#v1',revision:2});const hits=await backend!.search(pref.scope,'Iris preferences paragraphs');expect(hits.some(x=>x.id===pref.id&&x.text.includes('detailed paragraphs')),'Corrected memory missing');expect(!hits.some(x=>x.text.includes('prefers concise bullet')),'Old preference remains active');return hits;});
  await check('revision-history','backend',async()=>{const history=await backend!.history(pref.scope,pref.id);expect(history.length>=2,'Expected original and corrected revisions');return history;});
  await check('extractor-cannot-edit-soul','application',async()=>{let denied=false;try{souls!.edit('memory-extractor',{...iris,personality:ember.personality,revision:2});}catch{denied=true;}expect(denied&&souls!.get('iris')!.personality===iris.personality,'Extraction changed Soul');return {denied};});
  await check('soul-survives-reopen','application',async()=>{souls!.close();souls=new Souls(resolve(dir,'souls.sqlite'));expect(JSON.stringify(souls.get('iris'))===JSON.stringify(iris),'Soul changed after reopening database');return souls.get('iris');});
  await check('explicit-soul-edit-is-local','application',async()=>{souls!.edit('human-owner',{...iris,expression:'简洁，同时解释必要背景。',revision:2});expect(souls!.get('iris')!.revision===2,'Soul edit lost');expect(JSON.stringify(souls!.get('ember'))===JSON.stringify(ember),'Editing Iris changed Ember');return {iris:souls!.get('iris'),ember:souls!.get('ember')};});
  await check('forget','backend',async()=>{await backend!.forget(pref.scope,pref.id);const hits=await backend!.search(pref.scope,'Iris preferences paragraphs');expect(!hits.some(x=>x.id===pref.id),'Deleted memory still returned');return hits;});
  await check('deleted-source-replay','backend',async()=>{await backend!.put(pref);const hits=await backend!.search(pref.scope,'concise bullet lists');expect(!hits.some(x=>x.id===pref.id),'Replaying old source resurrected deleted memory; application tombstone required');return hits;});
}catch(e:any){report.setup={status:'blocked',error:String(e.message).replaceAll(process.env.DEEPSEEK_API_KEY||'__NO_KEY__','[REDACTED]')};console.log('BLOCKED',report.setup.error);}
finally{
  if(backend)await backend.close().catch(()=>{});souls?.close();
  report.finishedAt=new Date().toISOString();
  report.summary={pass:report.checks.filter((x:any)=>x.status==='pass').length,fail:report.checks.filter((x:any)=>x.status==='fail').length};
  const suffix=process.env.MEMORY_EMBEDDING_MODE==='lexical'&&kind!=='sqlite'?'-lexical':'';
  const output=resolve('results',kind+suffix+'.json');await writeFile(output,JSON.stringify(report,null,2)+'\n');console.log(output,report.summary);
  process.exitCode=report.setup?.status==='blocked'?2:report.checks.some((x:any)=>x.status==='fail'&&x.layer!=='retrieval-quality')?1:0;
}
