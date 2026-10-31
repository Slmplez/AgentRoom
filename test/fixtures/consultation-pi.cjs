const fs=require('node:fs');
const input=require('node:readline').createInterface({input:process.stdin,terminal:false});
fs.appendFileSync(process.env.CONSULTATION_START_LOG,'start\n');
const send=record=>process.stdout.write(JSON.stringify(record)+'\n');
input.on('line',line=>{const r=JSON.parse(line);
  if(r.type==='get_state')send({type:'response',id:r.id,success:true,data:{sessionId:'protocol-fixture'}});
  if(r.type==='prompt'){
    send({type:'response',id:r.id,success:true,data:{}});
    send({type:'message_start',message:{role:'assistant'}});
    send({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'Protocol fixture advice'}],stopReason:'stop'}});
    send({type:'agent_settled'});
  }
  if(r.type==='abort')send({type:'response',id:r.id,success:true,data:{}});
});
input.on('close',()=>process.exit(0));
