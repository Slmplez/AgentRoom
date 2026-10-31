const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async read => { const end = Date.now() + 7000; while (Date.now() < end) { const result = await read(); if (result) return result; await wait(15); } throw Error('Consultation state timed out'); };
function engines(ids = ['advisor-a','advisor-b','advisor-c']) {
  const started = [], instances = [], stops = new Map(), options = { confirmClose: true };
  const agents = ids.map(id => ({ id, displayName: id, engine: 'pi', model: 'model-' + id, inspectStopped: async tag => stops.get(tag) === true,
    createEngine: async ({ executionTag }) => {
      let resolve, reject, question; const answer = new Promise((a,b) => { resolve = a; reject = b; }); answer.catch(() => {});
      const entry = { id, tag: executionTag, prompt: '', finish: text => resolve({ text, outcome: 'complete' }), fail: error => reject(error), ask: () => question({ id: 'extra', title: 'Extra input?' }), stopped: false };
      instances.push(entry); stops.set(executionTag, false);
      return { onQuestion(fn) { question = fn; }, async start() { started.push(id); }, prompt(text) { entry.prompt = text; return answer; }, async cancel() {}, async close() { entry.stopped = options.confirmClose; stops.set(executionTag, entry.stopped); reject(Error('Closed')); }, isStopped: () => entry.stopped };
    },
  }));
  return { agents, started, instances, stops, options };
}
async function setup(overrides = {}, existing) {
  const { createApplicationRuntime } = await import('../lib/application-runtime/index.mjs');
  const { startPersistenceHttp } = await import('../lib/application-http/index.mjs');
  const directory = existing || await fs.mkdtemp(path.join(os.tmpdir(), 'agentroom-consultations-'));
  const e = overrides.e || engines();
  const { e: unused, ...configuration } = overrides;
  const runtime = await createApplicationRuntime({ directory, consultationAgents: e.agents, ...configuration });
  const http = await startPersistenceHttp({ runtime });
  const request = async (route, body, key = 'command') => {
    const response = await fetch(http.origin + '/api/v1' + route, { method: body ? 'POST' : 'GET', headers: { authorization: 'Bearer ' + http.token, ...(body ? { 'content-type': 'application/json', 'idempotency-key': key } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  };
  const boot = (await request('/bootstrap')).data;
  const rooms = (await request('/rooms?workspaceId=' + boot.workspace.id)).data;
  const roomId = rooms[0]?.id || (await request('/rooms', { workspaceId: boot.workspace.id, title: '咨询验证' }, 'room')).data.roomId;
  const command = (type, args = {}, key = crypto.randomUUID()) => request('/consultations/commands', { type, workspaceId: boot.workspace.id, roomId, ...args }, key);
  const get = id => runtime.query({ type: 'consultation', roomId, consultationId: id }, runtime.owner);
  const create = async (agentIds = ['advisor-a'], extra = {}, key) => { const r = await command('createConsultation', { title: 'How should we proceed?', agentIds, ...extra }, key); assert.equal(r.status, 200, JSON.stringify(r.data)); return r.data.consultationId; };
  const act = (type, id, args = {}, key) => command(type, { consultationId: id, expectedRevision: get(id).revision, ...args }, key);
  return { directory, e, runtime, http, request, boot, roomId, command, get, create, act, close: async () => { await http.close(); runtime.close(); } };
}

test('durable consultation FIFO skips busy Agent, caps concurrency, loads distinct Souls, and does not adopt automatically', async () => {
  const s = await setup();
  try {
    for (const id of ['advisor-a','advisor-b']) s.runtime.execute({ type: 'editAgentSoul', key: id, workspaceId: s.boot.workspace.id, agentId: id, expectedRevision: 0, personality: 'Soul ' + id, expression: '', workStyle: '' }, s.runtime.owner);
    const q1 = await s.create(['advisor-a'], {}, 'same-create');
    const repeated = await s.command('createConsultation', { title: 'How should we proceed?', agentIds: ['advisor-a'] }, 'same-create');
    assert.equal(repeated.data.consultationId, q1);
    const q2 = await s.create(['advisor-a','advisor-b']);
    await until(() => s.e.started.length === 2);
    assert.deepEqual(s.e.started, ['advisor-a','advisor-b']);
    assert.equal(s.get(q2).assignments[0].status, 'queued');
    assert.ok(s.e.instances.find(e => e.id === 'advisor-a').prompt.includes('Soul advisor-a'));
    assert.ok(s.e.instances.find(e => e.id === 'advisor-b').prompt.includes('Soul advisor-b'));
    s.e.instances[0].finish('first answer'); await until(() => s.e.started.length === 3);
    s.e.instances[1].finish('B advice'); s.e.instances[2].finish('A advice');
    await until(() => s.get(q2).assignments.every(a => a.status === 'answered'));
    assert.equal(s.get(q2).status, 'pending'); assert.equal(s.get(q2).startsUsed, 2);
    const q = s.get(q2), input = { consultationId: q2, expectedRevision: q.revision, adoptedAssignmentId: q.assignments[1].id };
    const decisions = await Promise.all([s.command('decideConsultation', input, 'decision-1'), s.command('decideConsultation', input, 'decision-2')]);
    assert.deepEqual(decisions.map(r => r.status).sort(), [200,409]);
    assert.equal(s.get(q2).response.text, 'B advice');
    const context = s.runtime.query({ type: 'consultationContext', roomId: s.roomId, consultationId: q2, assignmentId: q.assignments[1].id }, s.runtime.owner);
    assert.equal(context.agentId, 'advisor-b'); assert.equal(context.prompt, s.e.instances[1].prompt);
    assert.equal((await s.command('createConsultation', { title: 'bad', agentIds: ['advisor-a','advisor-a'] })).status, 400);
    assert.equal((await s.command('createConsultation', { title: 'bad', agentIds: ['unknown'] })).status, 400);
    assert.equal((await s.request('/consultations/commands', { type: 'localFact', roomId: s.roomId, workspaceId: s.boot.workspace.id })).status, 400);
  } finally { await s.close(); }
});

test('unconfirmed close retains the Agent lease; explicit inspection and abandonment never replay an assignment', async () => {
  const e = engines(); e.options.confirmClose = false;
  const s = await setup({ e });
  try {
    const q1 = await s.create(); await until(() => e.started.length === 1);
    const q2 = await s.create();
    await s.act('cancelConsultation', q1);
    await until(() => s.get(q1).assignments[0].status === 'unknown');
    const assignmentId = s.get(q1).assignments[0].id;
    assert.equal(s.get(q1).assignments[0].leaseHeld, true);
    assert.equal((await s.act('abandonConsultation', q1, { assignmentId })).status, 409);
    await s.act('checkConsultation', q1, { assignmentId }); await wait(100);
    assert.equal(e.started.length, 1); assert.equal(s.get(q2).assignments[0].status, 'queued');
    e.instances[0].stopped = true;
    await s.act('checkConsultation', q1, { assignmentId });
    await until(() => !s.get(q1).assignments[0].leaseHeld);
    assert.equal((await s.act('abandonConsultation', q1, { assignmentId })).status, 200);
    await until(() => e.started.length === 2);
    assert.equal(s.get(q1).assignments[0].status, 'abandoned');
  } finally { e.options.confirmClose = true; await s.close(); }
});

test('restart pauses queued work, marks dispatched work unknown, and only explicit resume starts a new pending assignment', async () => {
  const e = engines(); let s = await setup({ e }); const directory = s.directory;
  const q1 = await s.create(); await until(() => e.started.length === 1); const q2 = await s.create();
  await s.close(); s = await setup({ e }, directory);
  try {
    assert.equal(s.get(q1).assignments[0].status, 'unknown'); assert.equal(s.get(q2).assignments[0].status, 'paused');
    await wait(350); assert.equal(e.started.length, 1);
    await s.act('checkConsultation', q1, { assignmentId: s.get(q1).assignments[0].id });
    await until(() => !s.get(q1).assignments[0].leaseHeld);
    await s.act('resumeConsultation', q2, { assignmentId: s.get(q2).assignments[0].id });
    await until(() => e.started.length === 2);
    assert.equal(s.get(q1).startsUsed, 1); assert.equal(s.get(q2).startsUsed, 1);
  } finally { await s.close(); }
});

test('timeout and unexpected input stop a consultation; expired questions cannot be answered or resumed', async () => {
  const s = await setup({ consultationTiming: { executionMs: 60, questionMs: 1000 } });
  try {
    const q = await s.create(); await until(() => s.get(q).assignments[0].status === 'failed');
    assert.equal(s.get(q).assignments[0].leaseHeld, false); assert.equal(s.e.started.length, 1);
    const q2 = await s.create(); await until(() => s.e.started.length === 2);
    assert.throws(() => s.e.instances[1].ask(), /input/);
    await until(() => s.get(q2).assignments[0].status === 'failed');
    await until(() => s.get(q2).status === 'expired');
    assert.equal((await s.act('decideConsultation', q2, { text: 'late answer' })).status, 409);
  } finally { await s.close(); }
});

test('queue cap reserves paused and queued assignments and at most three Agent requests fit in one question', async () => {
  const s = await setup();
  try {
    await s.create(); await until(() => s.e.started.length === 1);
    for (let i = 0; i < 20; i++) await s.create();
    const full = await s.command('createConsultation', { title: 'overflow', agentIds: ['advisor-a'] });
    assert.equal(full.status, 409); assert.equal(full.data.code, 'queue_full');
    assert.equal((await s.command('createConsultation', { title: 'four', agentIds: ['advisor-a','advisor-b','advisor-c','fourth'] })).status, 400);
    assert.equal(s.e.started.length, 1);
  } finally { await s.close(); }
});

test('explicit adoption atomically answers only the current native question and cancels sibling consultations', async () => {
  const { createPiQuestionEngine } = await import('../lib/local-question-engine.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(),'ar-consult-source-'));
  const log = path.join(directory,'native.log');
  const execution = { agentId:'local-pi', createEngine: () => createPiQuestionEngine({ directory, env:{...process.env,LOCAL_ANSWER_LOG:log}, command:{command:process.execPath,args:[path.join(__dirname,'fixtures/local-question-pi.cjs')]} }) };
  let s = await setup({execution},directory);
  try {
    const root = await s.request(`/rooms/${s.roomId}/local-tasks`,{workspaceId:s.boot.workspace.id,ownerAgentId:'local-pi',goal:'source question'},'root');
    const readTask = () => s.runtime.query({type:'localTask',roomId:s.roomId,taskId:root.data.taskId},s.runtime.owner);
    await until(() => readTask().phase === 'awaiting_input');
    const task = readTask(), source = {taskId:task.id,questionId:task.question.id,questionRevision:task.question.revision};
    const q1 = await s.create(['advisor-a','advisor-b'],{source});
    await until(() => s.e.started.length === 2);
    s.e.instances[0].finish('保留两周'); s.e.instances[1].finish('按阶段切换');
    await until(() => s.get(q1).assignments.every(a => a.status === 'answered'));
    assert.equal(readTask().phase,'awaiting_input');
    const q2 = await s.create(['advisor-c'],{source}); await until(() => s.e.started.length === 3);
    const before = s.runtime.query({type:'snapshot',roomId:s.roomId},s.runtime.owner).cursor;
    const q = s.get(q1), input = {consultationId:q1,expectedRevision:q.revision,adoptedAssignmentId:q.assignments[0].id};
    const decision = await s.command('decideConsultation',input,'adopt'); assert.equal(decision.status,200);
    assert.equal((await s.command('decideConsultation',input,'adopt')).data.operationId,decision.data.operationId);
    const events = s.runtime.query({type:'events',roomId:s.roomId,after:before},s.runtime.owner).events.filter(e => e.operationId === decision.data.operationId);
    assert.deepEqual(events.map(e => e.type),['consultation.updated','localTask.updated','consultation.updated']);
    assert.equal(s.get(q2).status,'resolved');
    await until(() => readTask().phase === 'reviewing');
    assert.equal(readTask().ownerAgentId,'local-pi'); assert.equal(readTask().result,'已继续：保留两周');
    assert.equal((await fs.readFile(log,'utf8')).split('\n').filter(line => line==='answer').length,1);
    assert.equal((await s.act('decideConsultation',q2,{adoptedAssignmentId:s.get(q2).assignments[0].id})).status,409);

    await until(() => !readTask().leaseHeld);
    const another = await s.request(`/rooms/${s.roomId}/local-tasks`,{workspaceId:s.boot.workspace.id,ownerAgentId:'local-pi',goal:'restart source'},'root-2');
    assert.equal(another.status,200);
    const secondTask = () => s.runtime.query({type:'localTask',roomId:s.roomId,taskId:another.data.taskId},s.runtime.owner);
    await until(() => secondTask().phase==='awaiting_input');
    const second = secondTask();
    const q3 = await s.create(['advisor-a'],{source:{taskId:second.id,questionId:second.question.id,questionRevision:second.question.revision}});
    await until(() => s.e.started.length===4); s.e.instances[3].finish('失效后仅留作决定');
    await until(() => s.get(q3).assignments[0].status==='answered');
    const e = s.e; await s.close(); s = await setup({execution,e},directory);
    assert.equal(secondTask().phase,'unknown');
    assert.equal((await s.act('decideConsultation',q3,{adoptedAssignmentId:s.get(q3).assignments[0].id})).status,200);
    assert.equal(s.get(q3).response.delivery,'unavailable');
    assert.equal(secondTask().phase,'unknown');
  } finally { await s.close(); }
});

test('two public Clients retain consultation projection and journal a lost decision response across reload without replay', async () => {
  const s = await setup(); const {createPersistentTransport} = await import('../renderer/client/persistent.mjs');
  const {createAgentRoomClient} = await import('../renderer/client/client.mjs');
  const values = new Map(), storage = {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k),key:i=>[...values.keys()][i]??null,get length(){return values.size;}};
  const clients=[];let lose=true,decisions=0;
  const make=async()=>{const client=createAgentRoomClient(createPersistentTransport({backendId:'consult-host',localUserId:'owner',storage,session:async()=>({origin:s.http.origin,token:s.http.token}),fetch:async(url,options)=>{const r=await fetch(url,options);if(options.body&&JSON.parse(options.body).type==='decideConsultation'){decisions++;if(lose){lose=false;await r.body.cancel();throw Error('Lost response');}}return r;}}));clients.push(client);await client.open({roomId:s.roomId});return client;};
  try {
    const a=await make(),b=await make();assert.equal(a.read().consultationAgents.length,3);
    const created=await a.dispatch({type:'createConsultation',key:'client-create',workspaceId:s.boot.workspace.id,roomId:s.roomId,title:'真实客户端建议',agentIds:['advisor-a'],instruction:'',source:null});
    await until(()=>s.e.started.length===1);s.e.instances[0].finish('客户端建议');
    await until(()=>b.read().consultations[0]?.assignments[0].status==='answered');
    const q=b.read().consultations[0];assert.equal(q.id,created.consultationId);
    await assert.rejects(a.dispatch({type:'decideConsultation',key:'lost-decision',workspaceId:s.boot.workspace.id,roomId:s.roomId,consultationId:q.id,expectedRevision:q.revision,text:'明确决定',adoptedAssignmentId:null}),{outcome:'unknown'});
    await until(()=>b.read().consultations[0].status==='resolved');
    a.close();const reloaded=await make();assert.equal(reloaded.read().pendingOperations.length,0);
    assert.equal(reloaded.read().consultations[0].response.text,'明确决定');assert.equal(decisions,1);
  } finally {clients.forEach(c=>c.close());await s.close();}
});

test('a completed local turn holds its Agent lease until delayed process close is confirmed', async () => {
  const e=engines(['shared-agent']);let finishRoot,releaseClose,rootStopped=false;
  const closeGate=new Promise(r=>releaseClose=()=>{rootStopped=true;r();});
  const execution={agentId:'shared-agent',createEngine:()=>({onQuestion(){},async start(){},prompt:()=>new Promise(r=>finishRoot=()=>r({text:'Root finished',outcome:'complete'})),async close(){await closeGate;},isStopped:()=>rootStopped})};
  const s=await setup({e,execution});
  try {
    const created=await s.request(`/rooms/${s.roomId}/local-tasks`,{workspaceId:s.boot.workspace.id,ownerAgentId:'shared-agent',goal:'root'},'root');
    await until(()=>finishRoot);finishRoot();
    const root=()=>s.runtime.query({type:'localTask',roomId:s.roomId,taskId:created.data.taskId},s.runtime.owner);
    await until(()=>root().phase==='reviewing');assert.equal(root().leaseHeld,true);
    const q=await s.create(['shared-agent']);await wait(300);assert.equal(e.started.length,0);
    assert.equal((await s.request(`/rooms/${s.roomId}/local-tasks`,{workspaceId:s.boot.workspace.id,ownerAgentId:'shared-agent',goal:'must wait'},'root-2')).status,409);
    releaseClose();await until(()=>e.started.length===1);assert.equal(rootStopped,true);assert.equal(root().leaseHeld,false);
    assert.equal(s.get(q).startsUsed,1);
  } finally {releaseClose();await s.close();}
});

test('uncertain prompt response remains unknown after confirmed process exit and is never automatically rerun', async()=>{
  const s=await setup();try{
    const q=await s.create();await until(()=>s.e.started.length===1);
    s.e.instances[0].fail(Object.assign(Error('Response lost after dispatch'),{uncertain:true}));
    await until(()=>s.get(q).assignments[0].status==='unknown');
    const assignmentId=s.get(q).assignments[0].id;
    assert.equal(s.get(q).assignments[0].stopConfirmed,true);assert.equal(s.get(q).assignments[0].leaseHeld,false);
    await wait(300);assert.equal(s.e.started.length,1);
    assert.equal((await s.act('checkConsultation',q,{assignmentId})).status,200);await wait(50);
    assert.equal((await s.act('abandonConsultation',q,{assignmentId})).status,200);
    assert.equal(s.e.started.length,1);
  }finally{await s.close();}
});

test('restart at reviewing with a terminal local lease only releases it after proving the tagged process has stopped',async()=>{
  const e=engines(['shared-agent']);let finishRoot,releaseClose,rootStopped=false,starts=0;
  const closeGate=new Promise(r=>releaseClose=r);
  const execution={agentId:'shared-agent',inspectStopped:async tag=>{assert.match(tag,/^[a-f0-9-]{36}$/);return rootStopped;},createEngine:({executionTag})=>{
    assert.match(executionTag,/^[a-f0-9-]{36}$/);starts++;
    return{onQuestion(){},async start(){},prompt:()=>new Promise(r=>finishRoot=()=>r({text:'Persistent complete result',outcome:'complete'})),async close(){await closeGate;},isStopped:()=>rootStopped};
  }};
  let s=await setup({e,execution});const directory=s.directory;
  try{
    const created=await s.request(`/rooms/${s.roomId}/local-tasks`,{workspaceId:s.boot.workspace.id,ownerAgentId:'shared-agent',goal:'terminal restart'},'root');
    const readRoot=()=>s.runtime.query({type:'localTask',roomId:s.roomId,taskId:created.data.taskId},s.runtime.owner);
    await until(()=>finishRoot);finishRoot();await until(()=>readRoot().phase==='reviewing');
    assert.equal(readRoot().leaseHeld,true);await s.close();s=await setup({e,execution},directory);
    assert.equal(readRoot().phase,'reviewing');assert.equal(readRoot().leaseHeld,true);
    await s.create(['shared-agent']);await wait(400);assert.equal(e.started.length,0);
    assert.equal((await s.request(`/rooms/${s.roomId}/local-tasks`,{workspaceId:s.boot.workspace.id,ownerAgentId:'shared-agent',goal:'must wait'},'root-2')).status,409);
    rootStopped=true;releaseClose();await until(()=>!readRoot().leaseHeld);
    await until(()=>e.started.length===1);assert.equal(starts,1);
    assert.equal(readRoot().phase,'reviewing');assert.equal(readRoot().result,'Persistent complete result');
  }finally{rootStopped=true;releaseClose();await s.close();}
});

test('process enumeration errors never establish termination; trusted DeepSeek bindings do not enter public Agent summaries',async()=>{
  const {inspectPiStopped,loadConsultationAgents}=await import('../lib/consultation-agents.mjs');const tag=crypto.randomUUID();
  assert.equal(await inspectPiStopped(tag,{platform:'win32',run:async(_file,args)=>{assert.ok(args.at(-1).includes("$ErrorActionPreference='Stop'"));return{stdout:'0\r\n',stderr:''};}}),true);
  assert.equal(await inspectPiStopped(tag,{platform:'win32',run:async()=>({stdout:'0\r\n',stderr:'CIM class unavailable'})}),false);
  assert.equal(await inspectPiStopped(tag,{platform:'win32',run:async()=>{throw Error('Enumeration denied');}}),false);
  assert.equal(await inspectPiStopped(tag,{platform:'win32',run:async()=>({stdout:'1\r\n',stderr:''})}),false);
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'ar-consult-config-'));const file=path.join(directory,'agents.json');
  await fs.writeFile(file,JSON.stringify({version:1,agents:[{id:'deepseek-advisor',displayName:'DeepSeek advisor',directory,provider:'deepseek',model:'deepseek-chat',envBindings:{DEEPSEEK_API_KEY:'MY_DEEPSEEK_SECRET'}}]}));
  const loaded=await loadConsultationAgents(file,{env:{...process.env,MY_DEEPSEEK_SECRET:'FIXTURE-SECRET'}});
  assert.equal(loaded.length,1);assert.equal(JSON.stringify(loaded).includes('FIXTURE-SECRET'),false);
  await assert.rejects(loadConsultationAgents(file,{env:{}}),/binding/);
});
