import { mkdir, readFile, rename, writeFile, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { embeddingModel, modelDirectory } from './embeddings.ts';

// curl respects HTTPS_PROXY; no global network configuration is changed.
const files=['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','onnx/model_quantized.onnx'];
await mkdir(modelDirectory,{recursive:true});
await rm(resolve(modelDirectory,'download-manifest.json'),{force:true});
const manifest:any={...embeddingModel,downloadedAt:new Date().toISOString(),files:[]};
for(const file of files){
  const destination=resolve(modelDirectory,file);
  await mkdir(dirname(destination),{recursive:true});
  console.log('Downloading',file);
  const url=`https://huggingface.co/${embeddingModel.id}/resolve/${embeddingModel.revision}/${file}`;
  const result=spawnSync(process.platform==='win32'?'curl.exe':'curl',['--fail','--location','--silent','--show-error','--retry','2','--connect-timeout','20','--max-time','900',url,'--output',destination+'.partial'],{stdio:'inherit'});
  if(result.error)throw result.error;
  if(result.status!==0)throw new Error(`Model download failed (${result.status}): ${file}`);
  const bytes=await readFile(destination+'.partial');
  if(file.endsWith('.json'))JSON.parse(bytes.toString());
  await rename(destination+'.partial',destination);
  manifest.files.push({file,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await writeFile(resolve(modelDirectory,'download-manifest.json'),JSON.stringify(manifest,null,2)+'\n');
console.log('Pinned model ready:',modelDirectory);
