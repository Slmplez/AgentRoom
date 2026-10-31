import { randomUUID } from 'node:crypto';
import { localTaskSchema } from '../../contracts/local-execution.mjs';
import { persistenceError as fail } from '../../contracts/persistence.mjs';

// Private behavior module; all writes run inside ApplicationRuntime's transaction.
export function localExecution({ db, configuration, commit, publishArtifact, publishForm, claimForm, acknowledgeForm, expireForm, captureContext, agentBusy = () => false, checkpoint = () => {} }) {
  const live = new Map(), starting = new Set(), inspecting = new Set(), nextInspection = new Map(); let stopped = false;
  const read = id => { const row = db.prepare('SELECT state_json FROM local_tasks WHERE id=?').get(id); if (!row) throw fail('not_found', '任务不存在。', 404); return JSON.parse(row.state_json); };
  const view = task => localTaskSchema.parse({ ...task, leaseHeld: task.executionLease === true });
  const save = task => db.prepare('INSERT INTO local_tasks(id,room_id,state_json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json').run(task.id, task.roomId, JSON.stringify(task));
  function apply(c, actor, mutation) {
    if (mutation) { const t = read(c.taskId); mutation(t); t.revision++; save(t); return view(t); }
    if (!configuration) throw fail('unsupported', '当前后端未启用本机 Agent 执行。', 422);
    if (c.type === 'createLocalTask') {
      if (c.ownerAgentId !== configuration.agentId) throw fail('invalid_owner', '负责人不是后端配置的 Agent。');
      if (agentBusy(c.ownerAgentId)) throw fail('busy', '该 Agent 的咨询执行尚未结束。', 409);
      const active = db.prepare('SELECT state_json FROM local_tasks').all().some(row => { const t = JSON.parse(row.state_json); return t.executionLease || ['queued', 'dispatching', 'running', 'awaiting_input', 'answer_pending', 'submitting', 'unknown'].includes(t.phase); });
      if (active) throw fail('busy', '已有执行或结果未知的任务，请先处理；不会并行启动另一个写进程。', 409);
      const t = { id: randomUUID(), runId: randomUUID(), initiatorId: actor.id, roomId: c.roomId, ownerAgentId: configuration.agentId, goal: c.goal, revision: 1, phase: 'queued', result: '', delivery: 'none', question: null, history: [], nativeId: null, incarnation: null, executionLease: true };
      save(t); return view(t);
    }
    const t = read(c.taskId), q = t.question;
    if (t.roomId !== c.roomId) throw fail('not_found', '任务不可访问。', 404);
    if (t.phase !== 'awaiting_input' || !q || q.status !== 'pending') throw fail('expired', '当前输入请求已失效。', 409);
    if (q.id !== c.questionId || q.revision !== c.expectedRevision) throw fail('conflict', '输入请求版本已变化。', 409);
    if (!live.has(t.id) || live.get(t.id).incarnation !== t.incarnation) throw fail('expired', '原引擎会话不可恢复。', 409);
    if (new Set(c.optionIds).size !== c.optionIds.length || (!q.multiple && c.optionIds.length > 1) || c.optionIds.some(id => !q.options.some(o => o.id === id)) || (!c.optionIds.length && !c.text.trim())) throw fail('invalid_answer', '请选择有效选项或输入答复。');
    q.response = { authorId: actor.id, optionIds: c.optionIds, text: c.text.trim() }; q.status = 'answered'; q.revision++;
    t.phase = 'answer_pending'; t.delivery = 'pending'; t.revision++; save(t); return view(t);
  }
  function fact(id, mutate) { if (!stopped) commit(id, mutate); }
  async function start(id) {
    if (starting.has(id) || live.has(id) || stopped) return;
    starting.add(id); let engine;
    try {
      const incarnation = randomUUID(); let context;
      checkpoint('before_context');
      fact(id, t => {
        if (t.phase !== 'queued') throw fail('invalid_transition', '任务已经开始或失效。', 409);
        context = captureContext(t);
        t.contextSnapshotId = context.snapshotId;
        t.phase = 'dispatching'; t.incarnation = incarnation; t.executionTagged = typeof configuration.inspectStopped === 'function';
        checkpoint('after_context_snapshot');
      });
      checkpoint('after_context_commit');
      engine = await configuration.createEngine({ executionTag: incarnation, ...(configuration.artifacts === true ? { publishArtifact: input => publishArtifact(id, incarnation, input) } : {}), ...(configuration.forms === true ? {requestForm:(input,options)=>requestForm(id,incarnation,input,options),acknowledgeForm:token=>acknowledge(id,incarnation,token)}:{}) });
      if (stopped) { await engine.close(); return; }
      live.set(id, { engine, incarnation, answering: false });
      engine.onQuestion(q => {
        if (stopped || live.get(id)?.incarnation !== incarnation) return;
        if (live.get(id)?.form) throw fail('invalid_transition', '已有表单等待，不能并发请求原生输入。', 409);
        fact(id, t => {
          if (!['dispatching', 'running', 'submitting'].includes(t.phase) || t.question?.status === 'pending') throw fail('invalid_transition', '引擎重复或并发请求输入。', 409);
          if (t.history.length >= 20) throw fail('limit_exceeded', '本次执行的问题数量超出限制。', 409);
          if (t.question) t.history.push(t.question);
          t.question = { id: randomUUID(), revision: 0, title: String(q.title).slice(0, 500), multiple: Boolean(q.multiple), options: (q.options || []).slice(0, 20).map((label, i) => ({ id: `choice-${i}`, label: String(label).slice(0, 300) })), status: 'pending', response: null };
          delete t.formWait;
          t.nativeId = String(q.id); t.phase = 'awaiting_input'; t.delivery = 'none';
        });
      });
      await engine.start();
      fact(id, t => { if (t.phase === 'dispatching') t.phase = 'running'; });
      // Send exactly the committed snapshot, never a fresh read of mutable memory.
      const result = await engine.prompt(context.prompt);
      fact(id, t => {
        if (['unknown', 'failed', 'paused'].includes(t.phase)) return;
        if (t.question?.status === 'pending') { t.question.status = 'expired'; t.phase = 'failed'; t.result = '引擎在等待答复前结束。'; }
        else { t.phase = result.outcome === 'complete' ? 'reviewing' : 'unknown'; t.result = String(result.text || '').slice(0, 16000); }
      });
    } catch (e) {
      fact(id, t => { t.phase = !t.contextSnapshotId && e.code === 'context_unavailable' ? 'failed' : 'unknown'; t.result = t.phase === 'failed' ? '启动配置缺失、损坏或超限，任务未启动。' : '执行未能确认完成，请核查；不会自动重跑。'; t.delivery = t.delivery === 'none' ? 'none' : 'unknown'; if (t.question?.status === 'pending') t.question.status = 'expired'; });
    } finally {
      starting.delete(id); invalidateForm(id); let confirmed = !engine;
      try { await engine?.close(); confirmed = engine ? await engine.isStopped?.() === true : true; } catch {}
      if (confirmed) { live.delete(id); fact(id, t => { t.executionLease = false; }); }
      else if (live.has(id)) live.get(id).closing = true;
    }
  }
  async function answer(id) {
    const entry = live.get(id); if (!entry || entry.answering || stopped) return;
    entry.answering = true;
    try {
      const t = read(id), q = t.question;
      if (t.phase==='answer_pending' && t.formWait && !q?.response) { await answerForm(id,entry); return; }
      if (t.phase !== 'answer_pending' || !q?.response) return;
      fact(id, current => { current.phase = 'submitting'; current.delivery = 'attempting'; });
      checkpoint('before_local_answer');
      await entry.engine.respond(t.nativeId, { optionLabels: q.response.optionIds.map(id => q.options.find(o => o.id === id).label), text: q.response.text });
      checkpoint('after_local_answer');
      fact(id, current => { if (current.question?.id !== q.id) return; if (current.phase === 'submitting') current.phase = 'running'; current.delivery = 'submitted'; });
    } catch { invalidateForm(id); fact(id, t => { t.phase = 'unknown'; t.delivery = 'unknown'; }); try { await entry.engine.close(); } catch {} }
    finally { entry.answering = false; }
  }
  function deferred() { let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});promise.catch(()=>{});return {promise,resolve,reject}; }
  function invalidateForm(id) {
    const entry=live.get(id),form=entry?.form;if(!form)return;
    if(!stopped && read(id).formWait) {try {expireForm(id);} catch {}}
    delete entry.form;form.result.reject(fail('expired','原表单等待已失效。',409));form.received.reject(fail('expired','原工具投递未确认。',409));
  }
  function requestForm(id,incarnation,input,{signal}={}) {
    const entry=live.get(id);
    if(stopped || !entry || entry.incarnation!==incarnation || signal?.aborted) throw fail('expired','当前执行不能建立新的表单等待。',409);
    if(entry.form) {const original=publishForm(id,incarnation,input);return Promise.resolve({publicationOnly:true,receipt:original.receipt});}
    const form={result:deferred(),received:deferred(),ref:null};entry.form=form;
    try {
      form.ref=publishForm(id,incarnation,input);
      const task=read(id);
      if(task.phase!=='awaiting_input' || task.formWait?.artifactId!==form.ref.artifactId || task.formWait?.version!==form.ref.version) {delete entry.form;return Promise.resolve({publicationOnly:true,receipt:form.ref.receipt});}
    } catch(error) { if(read(id).phase==='awaiting_input' && read(id).formWait) invalidateForm(id);else delete entry.form;throw error; }
    const abort=()=>{if(entry.form===form){invalidateForm(id);void entry.engine.close().catch(()=>{});}};
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    return form.result.promise.finally(()=>signal?.removeEventListener('abort',abort));
  }
  async function answerForm(id,entry) {
    const form=entry.form;
    if(!form || entry.incarnation!==read(id).incarnation)throw fail('expired','原工具等待已经消失。',409);
    const payload=claimForm(id);form.token=payload.acknowledgment;
    checkpoint('before_form_delivery');form.result.resolve(payload);checkpoint('after_form_delivery');
    let timer;
    try {await Promise.race([form.received.promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Original tool did not acknowledge receipt')),15000);})]);}
    finally {clearTimeout(timer);}
  }
  function acknowledge(id,incarnation,token) {
    const entry=live.get(id),form=entry?.form;
    if(stopped || !form || entry.incarnation!==incarnation || form.token!==token)throw fail('expired','原工具接收标识不可用。',409);
    const result=acknowledgeForm(id,token);checkpoint('after_form_ack');delete entry.form;form.received.resolve();return result;
  }
  const reaper = setInterval(() => {
    if (stopped) return;
    for (const [id, entry] of live) if (entry.closing) {
      try { if (entry.engine.isStopped?.() === true) { fact(id, t => { t.executionLease = false; }); live.delete(id); } } catch {}
    }
    if (typeof configuration?.inspectStopped === 'function') {
      const rows = db.prepare("SELECT state_json FROM local_tasks WHERE json_extract(state_json,'$.executionLease')=1 AND json_extract(state_json,'$.executionTagged')=1 AND json_extract(state_json,'$.phase') IN ('reviewing','failed')").all();
      for (const row of rows) {
        const task = JSON.parse(row.state_json);
        if (live.has(task.id) || inspecting.has(task.id) || Date.now() < (nextInspection.get(task.id) || 0)) continue;
        inspecting.add(task.id); nextInspection.set(task.id, Date.now()+5000);
        void (async () => {
          try { if (await configuration.inspectStopped(task.incarnation) === true) fact(task.id, t => { if (t.executionTagged && t.incarnation === task.incarnation && ['reviewing','failed'].includes(t.phase)) t.executionLease = false; }); }
          catch {} finally { inspecting.delete(task.id); }
        })();
      }
    }
  }, 250); reaper.unref?.();
  return {
    apply, read, view,
    formLive(id,incarnation,ref) {const entry=live.get(id),t=read(id);return !stopped && t.phase==='awaiting_input' && entry?.incarnation===incarnation && entry.form?.ref?.artifactId===ref.artifactId && entry.form?.ref?.version===ref.version;},
    canAnswer(id) { const t = read(id); return t.phase === 'awaiting_input' && t.question?.status === 'pending' && live.get(id)?.incarnation === t.incarnation; },
    busy(agentId) { return Boolean(db.prepare("SELECT 1 FROM local_tasks WHERE json_extract(state_json,'$.ownerAgentId')=? AND (json_extract(state_json,'$.executionLease')=1 OR json_extract(state_json,'$.phase') IN ('queued','dispatching','running','awaiting_input','answer_pending','submitting','unknown')) LIMIT 1").get(agentId)); },
    canPublish(id, incarnation) { const t = read(id); return !stopped && live.get(id)?.incarnation===incarnation && t.incarnation===incarnation && t.phase==='running'; },
    list: roomId => db.prepare('SELECT state_json FROM local_tasks WHERE room_id=? ORDER BY rowid DESC LIMIT 100').all(roomId).map(r => view(JSON.parse(r.state_json))),
    recover() { for (const row of db.prepare('SELECT state_json FROM local_tasks').all()) { const t = JSON.parse(row.state_json); if(t.formWait) {try{expireForm(t.id);}catch{throw fail('storage_error','表单等待恢复失败。',500);}} if (['queued', 'dispatching', 'running', 'awaiting_input', 'answer_pending', 'submitting'].includes(t.phase)) fact(t.id, current => { if (current.phase === 'queued') { current.phase = 'paused'; current.executionLease = false; } else current.phase = 'unknown'; if (current.question?.status === 'pending') current.question.status = 'expired'; if (['pending', 'attempting'].includes(current.delivery)) current.delivery = 'unknown'; }); } },
    schedule(id) { if (!configuration || stopped) return; queueMicrotask(() => { if (stopped) return; const t = read(id); if (t.phase === 'queued') void start(id).catch(() => {}); else if (t.phase === 'answer_pending') void answer(id).catch(() => {}); }); },
    shutdown() { stopped = true; for(const id of live.keys())invalidateForm(id); clearInterval(reaper); for (const { engine } of live.values()) void engine.close().catch(() => {}); live.clear(); },
  };
}
