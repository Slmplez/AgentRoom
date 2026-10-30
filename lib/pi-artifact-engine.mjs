import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPiQuestionEngine } from './local-question-engine.mjs';
import { parseReportJson } from './report-json.mjs';
import { artifactToolParameters } from '../contracts/artifacts.mjs';

// Only trusted host configuration can supply this callback. Its closure binds
// the run/incarnation; the tool never supplies identity or a destination path.
export async function createPiArtifactEngine({ publishArtifact, ...options }) {
  if(typeof publishArtifact!=='function') throw Error('Artifact publishing must be explicitly enabled.');
  const token=randomBytes(32).toString('hex'), expected=Buffer.from(`Bearer ${token}`);
  const directory=await mkdtemp(join(tmpdir(),'agentroom-artifact-'));
  let origin, engine, closing;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
    try {
      const supplied=Buffer.from(req.headers.authorization||'');
      if(req.headers.host!==new URL(origin).host||req.headers.origin||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)) {res.statusCode=403;res.end('{"error":"Forbidden"}');return;}
      if(req.method!=='POST'||req.url!=='/publish'||(req.headers['content-type']||'').split(';')[0]!=='application/json'){res.statusCode=404;res.end('{}');return;}
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>300*1024){res.statusCode=413;res.end('{"error":"Report too large"}');return;}chunks.push(chunk);}
      let input;try{input=parseReportJson(Buffer.concat(chunks).toString('utf8'));}catch{res.statusCode=400;res.end('{"error":"Invalid report JSON"}');return;}
      const receipt=await publishArtifact(input);res.end(JSON.stringify(receipt));
    }catch(e){res.statusCode=e.status||500;res.end(JSON.stringify({error:e.status?e.message:'Publication outcome unknown; check the original request key.',outcome:e.outcome||'unknown'}));}
  });
  server.requestTimeout=15000;server.headersTimeout=10000;
  async function close(){return closing ||= (async()=>{try{await engine?.close();}finally{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await rm(directory,{recursive:true,force:true});}})();}
  try {
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;
    const file=join(directory,'publish-report.mjs');
    await writeFile(file,`export default function(pi) {
      pi.registerTool({name:'publish_report',label:'Publish report',description:'Publish a read-only structured report for this task. Keep key stable for the same publication. No automatic retry after unknown results. catalogVersion is 1; spec contains root and elements of Section/Metrics/Bars/Table only.',
        parameters:${JSON.stringify(artifactToolParameters)},
        async execute(_id,params,signal){const r=await fetch(${JSON.stringify(origin+'/publish')},{method:'POST',headers:{authorization:${JSON.stringify('Bearer '+token)},'content-type':'application/json'},body:JSON.stringify(params),signal});const body=await r.json();return {content:[{type:'text',text:JSON.stringify(body)}],details:{publication:body},isError:!r.ok};}
      });
    }`,{mode:0o600});
    engine=createPiQuestionEngine({...options,args:[...(options.args||[]),'--extension',file,'--tools','read,grep,find,ls,publish_report']});
    return { ...engine, close };
  }catch(e){await close();throw e;}
}
