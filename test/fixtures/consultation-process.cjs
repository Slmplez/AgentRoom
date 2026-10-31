const path=require('node:path');
(async()=>{
  const directory=process.argv[2];let armed;
  const {createApplicationRuntime}=await import('../../lib/application-runtime/index.mjs');
  const {createPiQuestionEngine}=await import('../../lib/local-question-engine.mjs');
  const {startPersistenceHttp}=await import('../../lib/application-http/index.mjs');
  const runtime=await createApplicationRuntime({directory,consultationAgents:[{id:'advisor-a',displayName:'A',engine:'pi',model:'fixture',inspectStopped:async()=>true,createEngine:({executionTag})=>createPiQuestionEngine({directory,executionTag,env:{...process.env,CONSULTATION_START_LOG:path.join(directory,'starts.log')},command:{command:process.execPath,args:[path.join(__dirname,'consultation-pi.cjs')]}})}],fault(point){if(point===armed){process.send({type:'fault',point});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});
  const http=await startPersistenceHttp({runtime});process.send({type:'ready',origin:http.origin,token:http.token});
  process.on('message',async m=>{if(m.type==='arm'){armed=m.point;process.send({type:'armed'});}if(m.type==='shutdown'){await http.close();runtime.close();process.disconnect();}});
})().catch(e=>{console.error(e);process.exitCode=1;});
