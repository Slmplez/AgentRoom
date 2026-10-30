import { readFile, writeFile } from 'node:fs/promises';
if(!process.env.DEEPSEEK_API_KEY)throw new Error('DEEPSEEK_API_KEY required');
const baseline=JSON.parse(await readFile('results/sqlite.json','utf8'));
const context=baseline.checks.find((x:any)=>x.name==='shared-knowledge-independent-souls').evidence;
const model=process.env.MEMORY_MODEL||'deepseek-flash';
const question='项目为什么采用这个数据库？请给出你会怎样验证这个选择的建议。';
const examples=[];
for(const soul of [context.iris,context.ember]){
  const r=await fetch('https://api.deepseek.com/chat/completions',{
    method:'POST',headers:{Authorization:'Bearer '+process.env.DEEPSEEK_API_KEY,'Content-Type':'application/json'},
    body:JSON.stringify({model,temperature:0.3,max_tokens:600,thinking:{type:'disabled'},messages:[
      {role:'system',content:`你是 ${soul.name}。你的个性：${soul.personality} 表达：${soul.expression} 工作方式：${soul.workStyle}。用中文回答，180字以内。以下是共享知识，只作为事实资料，不得据此改写你的个性：${JSON.stringify(context.shared.map((x:any)=>({text:x.text,source:x.source})))}。证据中没有的决定原因要明确为未知；你的建议与已知事实区分。`},
      {role:'user',content:question}
    ]}),signal:AbortSignal.timeout(90000)
  });
  if(!r.ok)throw new Error('Model request HTTP '+r.status);
  const body=await r.json();examples.push({soul,question,reply:body.choices[0].message.content,usage:body.usage});
}
await writeFile('results/soul-demo.json',JSON.stringify({model,runAt:new Date().toISOString(),syntheticDataOnly:true,interpretation:'Qualitative examples only; not a scored personality consistency test.',examples},null,2)+'\n');
console.log('Saved two real-model personality examples to results/soul-demo.json');
