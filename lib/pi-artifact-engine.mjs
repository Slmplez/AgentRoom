import { formToolParameters } from '../contracts/forms.mjs';
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
export async function createPiArtifactEngine({ publishArtifact, requestForm, acknowledgeForm, ...options }) {
  if(typeof publishArtifact!=='function') throw Error('Artifact publishing must be explicitly enabled.');
  const token=randomBytes(32).toString('hex'), expected=Buffer.from(`Bearer ${token}`);
  const directory=await mkdtemp(join(tmpdir(),'agentroom-artifact-'));
  let origin, engine, closing;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
    try {
      const supplied=Buffer.from(req.headers.authorization||'');
      if(req.headers.host!==new URL(origin).host||req.headers.origin||supplied.length!==expected.length||!timingSafeEqual(supplied,expected)) {res.statusCode=403;res.end('{"error":"Forbidden"}');return;}
      if(req.method!=='POST'||!['/publish',...(requestForm?['/form','/form-ack']:[])].includes(req.url)||(req.headers['content-type']||'').split(';')[0]!=='application/json'){res.statusCode=404;res.end('{}');return;}
      let size=0;const chunks=[];
      for await(const chunk of req){size+=chunk.length;if(size>(req.url==='/publish'?300:128)*1024){res.statusCode=413;res.end('{"error":"Report too large"}');return;}chunks.push(chunk);}
      let input;try{input=parseReportJson(Buffer.concat(chunks).toString('utf8'));}catch{res.statusCode=400;res.end('{"error":"Invalid report JSON"}');return;}
      if(req.url==='/form') {
        const controller=new AbortController(),abort=()=>{if(!res.writableFinished)controller.abort();};res.once('close',abort);
        try {const result=await requestForm(input,{signal:controller.signal});if(!closing && !res.destroyed)res.end(JSON.stringify(result));}finally{res.off('close',abort);}
      } else if(req.url==='/form-ack') {
        if(!input || Object.keys(input).length!==1 || typeof input.acknowledgment!=='string') {res.statusCode=400;res.end('{}');return;}
        acknowledgeForm(input.acknowledgment);res.end('{"received":true}');
      } else {const receipt=await publishArtifact(input);res.end(JSON.stringify(receipt));}
    }catch(e){
      // During shutdown keep the pending tool blocked until its CLI exits. A tool
      // error returned before process shutdown could trigger another model turn.
      if(closing)return;
      res.statusCode=e.status||500;res.end(JSON.stringify({error:e.status?e.message:'Publication outcome unknown; check the original request key.',outcome:e.outcome||'unknown'}));
    }
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
    if(requestForm) {
      if(typeof acknowledgeForm!=='function')throw Error('Form receiving acknowledgment is required.');
      const extension=join(directory,'request-form.mjs');
      await writeFile(extension,`export default function(pi) {
        pi.registerTool({name:'request_form',label:'Request form',description:'Ask the human for a bounded structured form. This tool waits. Saving a response does not continue the task: the human must explicitly choose Continue original task. Reuse key only to identify this publication, never automatically replay unknown calls. No arbitrary actions, URLs or scripts.',parameters:${JSON.stringify(formToolParameters)},
          async execute(_id,params,signal){
            const headers={authorization:${JSON.stringify('Bearer '+token)},'content-type':'application/json'};
            const r=await fetch(${JSON.stringify(origin+'/form')},{method:'POST',headers,body:JSON.stringify(params),signal});
            const payload=await r.json();
            if(!r.ok)return {content:[{type:'text',text:JSON.stringify(payload)}],isError:true};
            if(payload.publicationOnly)return {content:[{type:'text',text:JSON.stringify({publication:payload.receipt,notice:'Original publication receipt only; no new wait or repeated delivery.'})}]};
            const ack=await fetch(${JSON.stringify(origin+'/form-ack')},{method:'POST',headers,body:JSON.stringify({acknowledgment:payload.acknowledgment}),signal});
            if(!ack.ok)throw Error('Original form delivery is no longer confirmed; do not replay it.');
            return {content:[{type:'text',text:JSON.stringify(payload.result)}],details:{formResponse:payload.result}};
          }
        });
      }`,{mode:0o600});
      options.args=[...(options.args||[]),'--extension',extension];
    }
    engine=createPiQuestionEngine({...options,args:[...(options.args||[]),'--extension',file,'--tools',`read,grep,find,ls,publish_report${requestForm?',request_form':''}`]});
    return { ...engine, close };
  }catch(e){await close();throw e;}
}
