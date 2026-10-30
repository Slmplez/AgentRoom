import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
export const embeddingModel={id:'Xenova/paraphrase-multilingual-MiniLM-L12-v2',revision:'2c4055b12046f11709e9df2c122e59ffbdc2f900'};
export const modelDirectory=resolve('runtime/models',embeddingModel.id,embeddingModel.revision);
// Real multilingual ONNX embeddings shared by both candidates, never a mock vector.
export async function embeddingServer(report:any) {
  const lexical=process.env.MEMORY_EMBEDDING_MODE==='lexical';
  const model=embeddingModel.id;
  const local=existsSync(resolve(modelDirectory,'download-manifest.json'));
  const started=performance.now();
  let embed:any;
  if(lexical){
    const words=new Intl.Segmenter('zh',{granularity:'word'});
    embed=async(texts:string[])=>({tolist:()=>texts.map(text=>{
      const vector=Array(384).fill(0);
      for(const x of words.segment(text.toLowerCase()))if(x.isWordLike){const hash=createHash('sha256').update(x.segment).digest();vector[hash.readUInt32LE(0)%384]+=1;}
      const norm=Math.hypot(...vector)||1;return vector.map(x=>x/norm);
    })});
    report.limitations.push('EXPLICIT lexical hashing mode: real SDK/storage/LLM integration, NOT a semantic embedding quality evaluation.');
  }else{
    const {pipeline,env}=await import('@huggingface/transformers');env.cacheDir=resolve('runtime/model-cache');
    embed=await pipeline('feature-extraction',local?modelDirectory:model,{dtype:'q8',device:'cpu',revision:embeddingModel.revision,local_files_only:local});
  }
  report.embedding={model:lexical?'sha256-word-hashing-384':model,mode:lexical?'lexical':'semantic',dimensions:384,device:'cpu',loadMs:Math.round(performance.now()-started),requests:0};
  if(!lexical)Object.assign(report.embedding,{revision:embeddingModel.revision,localFilesOnly:local});
  const server=createServer(async(req,res)=>{
    if(req.method!=='POST'||req.url!=='/v1/embeddings'){res.writeHead(404).end();return;}
    try{
      const chunks=[];for await(const c of req)chunks.push(c);
      const body=JSON.parse(Buffer.concat(chunks).toString());
      const texts=Array.isArray(body.input)?body.input:[body.input];
      if(!texts.every((x:any)=>typeof x==='string'))throw new Error('input must be text');
      const output=await embed(texts,{pooling:'mean',normalize:true});
      report.embedding.requests++;
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({object:'list',data:output.tolist().map((embedding:number[],index:number)=>({object:'embedding',index,embedding})),model,usage:{prompt_tokens:0,total_tokens:0}}));
    }catch{res.writeHead(500,{'Content-Type':'application/json'}).end(JSON.stringify({error:{message:'Local embedding failed'}}));}
  });
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));
  const address=server.address() as any;
  return {url:`http://127.0.0.1:${address.port}/v1`,close:()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());})};
}
