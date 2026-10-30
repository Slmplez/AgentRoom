// Installed Pi CLI + real publish_report extension + local-only inference.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {engineConnection}=require('../lib/engine-connections.cjs');
(async()=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ar-real-artifact-'));let runtime,listener,calls=0,modelReceipt;
  const input={key:'real-pi-report',expectedVersion:0,title:'真实工具报告',catalogVersion:1,spec:{root:'r',elements:{r:{type:'Section',props:{title:'验证结果',description:'来自真实 Pi 工具调用'},children:['m']},m:{type:'Metrics',props:{items:[{label:'已检查',value:'1',detail:'回环推理与真实扩展'}]},children:[]}}}};
  const provider=http.createServer(async(req,res)=>{
    try {
      assert.equal(req.url,'/v1/chat/completions');assert.equal(req.headers.authorization,'Bearer LOCAL-ONLY');
      let body='';for await(const chunk of req)body+=chunk;const data=JSON.parse(body);calls++;
      assert.ok(data.tools.some(t=>t.function.name==='publish_report'));
      assert.ok(data.tools.every(t=>['read','grep','find','ls','publish_report'].includes(t.function.name)));
      const first=calls===1;
      if(!first){const tool=data.messages.find(m=>m.role==='tool');assert.ok(tool,JSON.stringify(data.messages));modelReceipt=JSON.parse(typeof tool.content==='string'?tool.content:tool.content[0].text);assert.equal(modelReceipt.accepted,true);}
      const message=first?{role:'assistant',content:null,tool_calls:[{id:'report-call',type:'function',function:{name:'publish_report',arguments:JSON.stringify(input)}}]}:{role:'assistant',content:'report-published'};
      const reply={id:'report-fixture',object:'chat.completion',created:1,model:'report-model',choices:[{index:0,message,finish_reason:first?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:5,total_tokens:15}};
      res.writeHead(200,{'content-type':data.stream?'text/event-stream':'application/json'});
      if(!data.stream)return res.end(JSON.stringify(reply));
      const delta=first?{role:'assistant',tool_calls:[{index:0,...message.tool_calls[0]}]}:message;
      res.write('data: '+JSON.stringify({...reply,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}],usage:undefined})+'\n\n');
      res.end('data: '+JSON.stringify({...reply,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:first?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n');
    }catch(e){console.error(e);res.writeHead(500);res.end(e.message);}
  });
  try {
    await new Promise(r=>provider.listen(0,'127.0.0.1',r));const baseUrl=`http://127.0.0.1:${provider.address().port}`;
    const config=await engineConnection('pi',{name:'Local report',protocol:'chat',model:'report-model',contextWindow:128000,maxTokens:8192,reasoning:false},{baseUrl,token:'LOCAL-ONLY'},directory);
    const {createApplicationRuntime}=await import('../lib/application-runtime/index.mjs');
    const {createPiArtifactEngine}=await import('../lib/pi-artifact-engine.mjs');
    const {startPersistenceHttp}=await import('../lib/application-http/index.mjs');
    runtime=await createApplicationRuntime({directory:path.join(directory,'db'),execution:{agentId:'report-pi',artifacts:true,createEngine:({publishArtifact})=>createPiArtifactEngine({publishArtifact,directory,args:config.args,env:{...process.env,...config.env,PI_CODING_AGENT_DIR:path.join(directory,'pi-home')}})}});
    listener=await startPersistenceHttp({runtime});
    const request=async(route,body,key)=>{const r=await fetch(listener.origin+'/api/v1'+route,{method:body?'POST':'GET',headers:{authorization:`Bearer ${listener.token}`,...(body?{'content-type':'application/json','idempotency-key':key}:{})},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data;};
    const boot=await request('/bootstrap'),workspaceId=boot.workspace.id;
    const {roomId}=await request('/rooms',{workspaceId,title:'Real reports'},'room');
    const {taskId}=await request(`/rooms/${roomId}/local-tasks`,{workspaceId,ownerAgentId:'report-pi',goal:'请用 publish_report 发布只读报告，然后简短确认。'},'task');
    let done;const deadline=Date.now()+45000;
    while(Date.now()<deadline){done=await request(`/rooms/${roomId}/local-tasks/${taskId}`);if(['reviewing','unknown','failed'].includes(done.phase))break;await new Promise(r=>setTimeout(r,60));}
    assert.equal(done.phase,'reviewing',JSON.stringify(done));assert.equal(calls,2);assert.ok(modelReceipt);
    const messages=(await request(`/rooms/${roomId}/snapshot`)).messages;assert.equal(messages.length,1);assert.equal(messages[0].authorId,'report-pi');
    const ref=messages[0].artifactRefs[0];assert.equal(ref.artifactId,modelReceipt.artifactId);
    const report=await request(`/rooms/${roomId}/artifacts/${ref.artifactId}/versions/1`);assert.equal(report.taskId,taskId);assert.equal(report.spec.elements.r.props.description,'来自真实 Pi 工具调用');
    console.log('Passed: installed Pi CLI → real publish_report tool → scoped bridge → SQLite/message/receipt → authenticated HTTP → tool result continuation; 2 loopback inference requests, no paid provider calls.');
  }finally{await listener?.close();runtime?.close();provider.closeAllConnections();await new Promise(r=>provider.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
