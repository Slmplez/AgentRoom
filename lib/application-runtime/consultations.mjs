import { randomUUID, createHash } from 'node:crypto';
import { consultationSchema, consultationAgentSchema, CONSULTATION_LIMITS as LIMITS } from '../../contracts/consultations.mjs';
import { persistenceError as fail } from '../../contracts/persistence.mjs';

// Private behavior: mutations, snapshots, queue reservations and events all use
// the enclosing ApplicationRuntime transaction. Engines only run after commit.
export function consultations({ db, agents, commit, clock, captureContext, verifySource, deliverSource, localBusy, checkpoint = () => {}, executionMs = LIMITS.executionMs, questionMs = LIMITS.questionMs }) {
  const registry = new Map(agents.map(a => [a.id, a]));
  const live = new Map(), inspecting = new Set(); let stopped = false, scheduled = false;
  if (!(executionMs > 0 && executionMs <= LIMITS.executionMs && questionMs > 0 && questionMs <= LIMITS.questionMs)) throw Error('Invalid internal consultation timing.');
  const now = () => new Date(clock()).toISOString();
  const pending = () => db.prepare("SELECT state_json FROM consultations WHERE json_extract(state_json,'$.status')='pending'").all().map(row => JSON.parse(row.state_json));
  const jobs = id => db.prepare('SELECT state_json FROM consultation_jobs WHERE consultation_id=? ORDER BY position').all(id).map(row => JSON.parse(row.state_json));
  const queueSize = () => db.prepare("SELECT COUNT(*) AS n FROM consultation_jobs WHERE json_extract(state_json,'$.status') IN ('queued','paused')").get().n;
  const read = id => { const row = db.prepare('SELECT state_json FROM consultations WHERE id=?').get(id); if (!row) throw fail('not_found', '咨询问题不存在。', 404); return JSON.parse(row.state_json); };
  const save = (q, list) => {
    db.prepare('INSERT INTO consultations VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json').run(q.id, q.roomId, JSON.stringify(q));
    for (const job of list) db.prepare('INSERT INTO consultation_jobs(id,consultation_id,agent_id,state_json) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json').run(job.id, q.id, job.agentId, JSON.stringify(job));
  };
  const view = q => consultationSchema.parse({ ...q, assignments: jobs(q.id), startsUsed: jobs(q.id).filter(j => j.startedAt).length });
  const invalidate = list => { for (const j of list) { if (['queued','paused'].includes(j.status)) { j.status = 'cancelled'; j.finishedAt = now(); j.note = '尚未启动，已取消。'; } else if (j.leaseHeld && j.status !== 'unknown') { j.status = 'cancelling'; j.note = '已请求中止，尚未确认结束。'; } } };
  function apply(c, actor, mutation) {
    if (mutation) { const q = read(c.consultationId), list = jobs(q.id); mutation(q, list); q.revision++; save(q, list); return { question: view(q) }; }
    if (c.type === 'createConsultation') {
      if (!registry.size) throw fail('unsupported', '宿主未登记可执行的咨询 Agent。', 422);
      if (new Set(c.agentIds).size !== c.agentIds.length || c.agentIds.some(id => !registry.has(id))) throw fail('invalid_agent', '请选择已登记且不同的咨询 Agent。');
      if (queueSize() + c.agentIds.length > LIMITS.queued) throw fail('queue_full', '咨询等待队列已满，请先处理已有咨询。', 409);
      const verified = c.source ? verifySource(c.roomId, c.source) : null;
      const { contextText: sourceContext = '', ...descriptor } = verified || {};
      const source = verified ? descriptor : null;
      if (source && c.agentIds.includes(source.ownerAgentId)) throw fail('busy', '不能向正等待此问题答复的任务负责人咨询。', 409);
      const q = { id: randomUUID(), roomId: c.roomId, authorId: actor.id, revision: 1, title: c.title, instruction: c.instruction, source, sourceContext, createdAt: now(), expiresAt: new Date(clock() + questionMs).toISOString(), status: 'pending', response: null };
      const list = c.agentIds.map(agentId => ({ id: randomUUID(), agentId, runId: randomUUID(), status: 'queued', text: '', note: '', startedAt: null, finishedAt: null, leaseHeld: false, stopConfirmed: true, contextSnapshotId: null, incarnation: null, context: null, contextHash: null, inspect: false }));
      save(q, list); return { question: view(q) };
    }
    const q = read(c.consultationId), list = jobs(q.id);
    if (q.roomId !== c.roomId) throw fail('not_found', '咨询不属于当前房间。', 404);
    if (q.revision !== c.expectedRevision) throw fail('conflict', '咨询状态已更新，请核对后再次操作。', 409);
    const assignment = c.assignmentId && list.find(j => j.id === c.assignmentId);
    let task = null;
    if (['checkConsultation','abandonConsultation'].includes(c.type)) {
      if (!assignment || assignment.status !== 'unknown') throw fail('invalid_transition', '该执行不处于结果未知状态。', 409);
      if (c.type === 'checkConsultation') assignment.inspect = true;
      else { if (assignment.leaseHeld || !assignment.stopConfirmed) throw fail('stop_unconfirmed', '尚未确认原进程结束，不能释放执行槽或重新咨询。', 409); assignment.status = 'abandoned'; assignment.note = '已明确放弃旧执行，未知结果不会重试。'; }
    } else {
      if (q.status !== 'pending' || Date.parse(q.expiresAt) <= clock()) throw fail('expired', '咨询问题已结束或过期。', 409);
      if (c.type === 'resumeConsultation') {
        if (!assignment || assignment.status !== 'paused' || assignment.startedAt || !registry.has(assignment.agentId)) throw fail('invalid_transition', '只能恢复尚未启动且配置仍有效的咨询。', 409);
        assignment.status = 'queued'; assignment.note = '已明确恢复，等待调度。';
      } else if (c.type === 'cancelConsultation') { q.status = 'cancelled'; invalidate(list); }
      else {
        const adopted = c.adoptedAssignmentId && list.find(j => j.id === c.adoptedAssignmentId);
        if (c.adoptedAssignmentId && (!adopted || adopted.status !== 'answered')) throw fail('invalid_adoption', '只能采纳本问题已完成的当前建议。', 409);
        const text = adopted ? adopted.text : c.text.trim();
        if (!text) throw fail('invalid_answer', '请选择已完成建议或输入你的决定。');
        if (q.source) task = deliverSource(q.roomId, q.source, text, actor);
        q.response = { authorId: actor.id, text, adoptedAssignmentId: adopted ? adopted.id : null, delivery: q.source ? task ? 'recorded' : 'unavailable' : 'none' };
        q.status = 'resolved'; invalidate(list);
      }
    }
    q.revision++; save(q, list); return { question: view(q), task };
  }
  const fact = (id, mutation) => { if (!stopped) commit(id, mutation); };
  const occupied = agentId => Boolean(db.prepare("SELECT 1 FROM consultation_jobs WHERE json_extract(state_json,'$.leaseHeld')=1 AND agent_id=? LIMIT 1").get(agentId));
  function sourceAnswered(task, actor) {
    const result = [];
    for (const q of pending()) if (q.source?.taskId === task.id && q.source.questionId === task.question?.id) {
      const list = jobs(q.id); q.status = 'resolved'; q.response = { authorId: actor.id, text: task.question.response.text, adoptedAssignmentId: null, delivery: 'recorded' }; invalidate(list); q.revision++; save(q, list); result.push(view(q));
    }
    return result;
  }
  function matching(entry, list) { return list.find(j => j.id === entry.id && j.incarnation === entry.incarnation); }
  async function finish(entry) {
    if (entry.finishing) return entry.finishing;
    return entry.finishing = (async () => {
      let confirmed = !entry.engine;
      try { await entry.engine?.close(); confirmed = entry.engine ? await entry.engine.isStopped?.() === true : true; } catch { confirmed = false; }
      clearTimeout(entry.timer);
      fact(entry.questionId, (q, list) => {
        const j = matching(entry, list); if (!j) return;
        const cancelled = q.status !== 'pending' || j.status === 'cancelling' || entry.stopReason;
        j.text = entry.text || ''; j.finishedAt = now(); j.leaseHeld = !confirmed; j.stopConfirmed = confirmed;
        if (!confirmed) { j.status = 'unknown'; j.note = '尚未确认进程结束，执行槽保持占用；不会自动重试。'; }
        else if (cancelled) { j.status = entry.failure ? 'failed' : 'cancelled'; j.note = entry.stopReason || '原问题已结束，输出仅保留为历史。'; }
        else { j.status = entry.outcome === 'complete' ? 'answered' : entry.uncertain ? 'unknown' : entry.failure ? 'failed' : 'unknown'; j.note = entry.uncertain ? '请求已经派发，但结果未能确认；即使进程已停止也不会重试。' : entry.failure || (j.status === 'unknown' ? '没有收到明确完成事实，不会重试。' : ''); }
      });
      if (confirmed) live.delete(entry.id);
      schedule();
    })();
  }
  async function stop(entry, reason, failure = false) {
    if (entry.stopReason) return;
    entry.stopReason = reason; if (failure) entry.failure = reason;
    fact(entry.questionId, (_q, list) => { const j = matching(entry, list); if (j?.leaseHeld) { j.status = 'cancelling'; j.note = reason + ' 正在确认进程结束。'; } });
    if (!entry.engine) return;
    try { await Promise.race([entry.engine.cancel?.(), new Promise(resolve => { const t = setTimeout(resolve, 500); t.unref?.(); })]); } catch {}
    await finish(entry);
  }
  async function start(question, original) {
    const entry = { id: original.id, questionId: question.id, incarnation: randomUUID(), engine: null, text: '', outcome: null, failure: '', stopReason: '', finishing: null, timer: null };
    let context;
    fact(question.id, (q, list) => {
      const j = list.find(j => j.id === original.id);
      if (q.status !== 'pending' || Date.parse(q.expiresAt) <= clock() || j?.status !== 'queued' || j.startedAt || list.filter(j => j.startedAt).length >= LIMITS.starts) throw fail('expired', '咨询已失效。', 409);
      context = captureContext({ id: j.id, runId: j.runId, roomId: q.roomId, ownerAgentId: j.agentId, goal: `请为以下问题提供建议。只返回你的分析，不请求授权，不发起子咨询。\n问题：${q.title}\n分析要求：${q.instruction}${q.sourceContext ? '\n已核实的来源任务与原问题：\n' + q.sourceContext : ''}` });
      j.context = context; j.contextHash = createHash('sha256').update(JSON.stringify(context)).digest('hex'); j.contextSnapshotId = context.snapshotId;
      j.startedAt = now(); j.status = 'dispatching'; j.leaseHeld = true; j.stopConfirmed = false; j.incarnation = entry.incarnation;
      checkpoint('after_consultation_reservation');
    });
    if (stopped) return;
    live.set(entry.id, entry);
    entry.timer = setTimeout(() => { void stop(entry, '咨询执行超时。', true); }, executionMs); entry.timer.unref?.();
    try {
      checkpoint('before_consultation_start');
      entry.engine = await registry.get(original.agentId).createEngine({ executionTag: entry.incarnation });
      if (stopped || entry.stopReason) { await finish(entry); return; }
      entry.engine.onQuestion(() => { void stop(entry, '咨询 Agent 请求了额外输入，已中止；请另建完整问题。', true); throw Error('Consultation input is unavailable'); });
      await entry.engine.start();
      checkpoint('after_consultation_start');
      if (stopped || entry.stopReason || read(question.id).status !== 'pending') { await finish(entry); return; }
      fact(question.id, (_q, list) => { const j = matching(entry, list); if (j?.status === 'dispatching') j.status = 'running'; });
      entry.dispatched = true;
      const result = await entry.engine.prompt(context.prompt);
      checkpoint('after_consultation_prompt');
      entry.text = String(result.text || '').slice(0, 4000); entry.outcome = result.outcome;
    } catch (error) { entry.uncertain = error.uncertain === true || (entry.dispatched && error.outcome !== 'failed'); entry.failure = '咨询执行未完成：' + (error.code === 'context_unavailable' ? '启动配置不可用。' : '请核查该 Agent 的配置或原执行。'); }
    finally { await finish(entry); }
  }
  async function inspect(q, j) {
    if (inspecting.has(j.id)) return;
    inspecting.add(j.id);
    const entry = live.get(j.id);
    let confirmed = false;
    try { confirmed = entry?.engine ? await entry.engine.isStopped?.() === true : await registry.get(j.agentId)?.inspectStopped?.(j.incarnation) === true; } catch {}
    fact(q.id, (_q, list) => { const current = list.find(item => item.id === j.id); if (current?.status === 'unknown') { current.inspect = false; current.stopConfirmed = confirmed; current.leaseHeld = !confirmed; current.note = confirmed ? '已核查原进程不再运行，可明确放弃该未知结果。' : '无法确认原进程结束，保持执行槽占用；请停止原进程后再核查。'; } });
    if (confirmed) live.delete(j.id);
    inspecting.delete(j.id);
  }
  function pump() {
    if (stopped) return;
    const expired = db.prepare("SELECT id FROM consultations WHERE json_extract(state_json,'$.status')='pending' AND json_extract(state_json,'$.expiresAt')<=?").all(now());
    for (const q of expired) fact(q.id, (current, list) => { current.status = 'expired'; invalidate(list); });
    const actions = db.prepare("SELECT consultation_id,state_json FROM consultation_jobs WHERE json_extract(state_json,'$.inspect')=1 OR json_extract(state_json,'$.status')='cancelling'").all();
    for (const row of actions) {
      const j = JSON.parse(row.state_json);
      if (j.inspect) void inspect(read(row.consultation_id), j).catch(() => { inspecting.delete(j.id); });
      if (j.status === 'cancelling') { const entry = live.get(j.id); if (entry) void stop(entry, '问题已决定或撤销。'); }
    }
    const leases = db.prepare("SELECT agent_id FROM consultation_jobs WHERE json_extract(state_json,'$.leaseHeld')=1").all();
    const busy = new Set(leases.map(row => row.agent_id)); let count = leases.length;
    const queued = db.prepare("SELECT consultation_id,state_json FROM consultation_jobs WHERE json_extract(state_json,'$.status')='queued' ORDER BY position LIMIT 20").all();
    for (const row of queued) {
      if (count >= LIMITS.concurrency) break;
      const j = JSON.parse(row.state_json);
      if (busy.has(j.agentId) || localBusy(j.agentId)) continue;
      const q = read(row.consultation_id);
      if (q.status !== 'pending' || Date.parse(q.expiresAt) <= clock()) continue;
      count++; busy.add(j.agentId);
      void start(q, j).catch(() => { fact(q.id, (_q, list) => { const job = list.find(item => item.id === j.id); job.status = job.startedAt ? 'unknown' : 'failed'; job.note = job.startedAt ? '启动结果未知，不会自动重试。' : '启动配置不可用，未启动引擎。'; }); });
    }
  }
  function schedule() { if (stopped || scheduled) return; scheduled = true; queueMicrotask(() => { scheduled = false; pump(); }); }
  const timer = setInterval(schedule, 250); timer.unref?.();
  return {
    apply, read, view, sourceAnswered, schedule, occupied,
    agents: () => agents.map(a => consultationAgentSchema.parse(a)),
    list: roomId => db.prepare('SELECT state_json FROM consultations WHERE room_id=? ORDER BY rowid DESC LIMIT 100').all(roomId).map(row => view(JSON.parse(row.state_json))),
    context(q, assignmentId) { const j = jobs(q.id).find(j => j.id === assignmentId); if (!j?.context || createHash('sha256').update(JSON.stringify(j.context)).digest('hex') !== j.contextHash) throw fail('context_unavailable', '该咨询尚无可核查的上下文快照。', 409); return j.context; },
    recover() { const rows = db.prepare("SELECT DISTINCT consultation_id FROM consultation_jobs WHERE json_extract(state_json,'$.status') IN ('queued','dispatching','running','cancelling')").all(); for (const row of rows) fact(row.consultation_id, (_q, list) => { for (const j of list) { if (j.status === 'queued') j.status = 'paused'; else if (j.leaseHeld) { j.status = 'unknown'; j.note = '宿主已重启，原执行结果未知；不会自动继续。'; j.inspect = false; } } }); },
    shutdown() { stopped = true; clearInterval(timer); for (const entry of live.values()) { clearTimeout(entry.timer); void entry.engine?.close().catch(() => {}); } live.clear(); },
  };
}
