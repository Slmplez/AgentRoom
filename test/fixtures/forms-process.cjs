const path=require('node:path'),fs=require('node:fs/promises');
(async()=>{
  const directory=process.argv[2],real=process.argv.includes('--real-pi');let scope='',armed;
  if(real && (!process.argv.includes('--agent-forms') || !process.argv.includes('--agent-reports')))throw Error('Forms/reports must be explicitly enabled');
  const {createApplicationRuntime}=await import('../../lib/application-runtime/index.mjs'),{startPersistenceHttp}=await import('../../lib/application-http/index.mjs');
  const config=real?JSON.parse(await fs.readFile(path.join(directory,'test-pi-config.json'),'utf8')):null;
  const {createPiArtifactEngine}=await import('../../lib/pi-artifact-engine.mjs');
  const runtime=await createApplicationRuntime({directory,execution:{agentId:'local-pi',artifacts:true,forms:true,createEngine(options){
    const requestForm=(input,context)=>{scope='publishForm';try{return options.requestForm(input,context);}finally{scope='';}};
    if(real)return createPiArtifactEngine({...options,requestForm,directory,env:{...process.env,...config.env,PI_CODING_AGENT_DIR:path.join(directory,'pi-home')},args:config.args});
    let close;const closed=new Promise(resolve=>{close=resolve;});let stopped=false;
    return {onQuestion(){},async start(){},async prompt(){
      const waiting=requestForm({key:'fixture-form',expectedVersion:0,title:'Durable form',spec:{groups:[{id:'g',title:'G',fields:[{id:'answer',type:'text',label:'Answer',required:true}]}]}});
      const result=await Promise.race([waiting,closed]);if(result){options.acknowledgeForm(result.acknowledgment);return {text:'done',outcome:'complete'};}return {text:'',outcome:'unknown'};
    },isStopped:()=>stopped,async close(){stopped=true;close();}};
  }},fault(point){if(armed?.point===point && (armed.operation===scope || armed.operation==='delivery' && ['before_form_delivery','after_form_delivery','after_form_ack'].includes(point))){process.send({type:'fault',point});Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}}});
  const execute=runtime.execute;runtime.execute=(input,actor)=>{scope=input.type;try{return execute(input,actor);}finally{scope='';}};
  const listener=await startPersistenceHttp({runtime});process.send({type:'ready',origin:listener.origin,token:listener.token});
  process.on('message',async input=>{
    if(input.type==='arm'){armed=input;process.send({type:'armed'});}
    if(input.type==='seed-pending'){
      const {createHash}=require('node:crypto'),workspaceId=runtime.query({type:'bootstrap'},runtime.owner).workspace.id,roomId=runtime.query({type:'rooms',workspaceId},runtime.owner)[0].id,bytes=Buffer.from('pagination');
      for(let i=0;i<101;i++)runtime.uploadAttachment({type:'uploadAttachment',key:'pagination-'+i,workspaceId,roomId,name:`pending-${i}.txt`,size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')},bytes,runtime.owner);
      process.send({type:'seeded'});
    }
    if(input.type==='shutdown'){await listener.close();runtime.close();process.disconnect();}
  });
})().catch(error=>{console.error(error);process.exitCode=1;});
