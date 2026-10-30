import { randomUUID } from 'node:crypto';
import { localTaskSchema } from '../../contracts/local-execution.mjs';
import { persistenceError as fail } from '../../contracts/persistence.mjs';

// Private behavior module; all writes run inside ApplicationRuntime's transaction.
export function localExecution({ db, configuration, commit, checkpoint = () => {} }) {
  const live = new Map(), starting = new Set(); let stopped = false;
  const read = id => { const row = db.prepare('SELECT state_json FROM local_tasks WHERE id=?').get(id); if (!row) throw fail('not_found', '任务不存在。', 404); return JSON.parse(row.state_json); };
  const view = task => localTaskSchema.parse(task);
  const save = task => db.prepare('INSERT INTO local_tasks(id,room_id,state_json) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json').run(task.id, task.roomId, JSON.stringify(task));
  function apply(c, actor, mutation) {
    if (mutation) { const t = read(c.taskId); mutation(t); t.revision++; save(t); return view(t); }
    if (!configuration) throw fail('unsupported', '当前后端未启用本机 Agent 执行。', 422);
    if (c.type === 'createLocalTask') {
      if (c.ownerAgentId !== configuration.agentId) throw fail('invalid_owner', '负责人不是后端配置的 Agent。');
      const active = db.prepare('SELECT state_json FROM local_tasks').all().some(row => ['queued', 'dispatching', 'running', 'awaiting_input', 'answer_pending', 'submitting', 'unknown'].includes(JSON.parse(row.state_json).phase));
      if (active) throw fail('busy', '已有执行或结果未知的任务，请先处理；不会并行启动另一个写进程。', 409);
      const t = { id: randomUUID(), runId: randomUUID(), initiatorId: actor.id, roomId: c.roomId, ownerAgentId: configuration.agentId, goal: c.goal, revision: 1, phase: 'queued', result: '', delivery: 'none', question: null, history: [], nativeId: null, incarnation: null };
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
      const incarnation = randomUUID(); fact(id, t => { t.phase = 'dispatching'; t.incarnation = incarnation; });
      engine = await configuration.createEngine();
      if (stopped) { await engine.close(); return; }
      live.set(id, { engine, incarnation, answering: false });
      engine.onQuestion(q => {
        if (stopped || live.get(id)?.incarnation !== incarnation) return;
        fact(id, t => {
          if (!['dispatching', 'running', 'submitting'].includes(t.phase) || t.question?.status === 'pending') throw fail('invalid_transition', '引擎重复或并发请求输入。', 409);
          if (t.history.length >= 20) throw fail('limit_exceeded', '本次执行的问题数量超出限制。', 409);
          if (t.question) t.history.push(t.question);
          t.question = { id: randomUUID(), revision: 0, title: String(q.title).slice(0, 500), multiple: Boolean(q.multiple), options: (q.options || []).slice(0, 20).map((label, i) => ({ id: `choice-${i}`, label: String(label).slice(0, 300) })), status: 'pending', response: null };
          t.nativeId = String(q.id); t.phase = 'awaiting_input'; t.delivery = 'none';
        });
      });
      await engine.start();
      fact(id, t => { if (t.phase === 'dispatching') t.phase = 'running'; });
      const result = await engine.prompt(read(id).goal);
      fact(id, t => {
        if (['unknown', 'failed', 'paused'].includes(t.phase)) return;
        if (t.question?.status === 'pending') { t.question.status = 'expired'; t.phase = 'failed'; t.result = '引擎在等待答复前结束。'; }
        else { t.phase = result.outcome === 'complete' ? 'reviewing' : 'unknown'; t.result = String(result.text || '').slice(0, 16000); }
      });
    } catch (e) {
      fact(id, t => { t.phase = 'unknown'; t.result = '执行未能确认完成，请核查；不会自动重跑。'; t.delivery = t.delivery === 'none' ? 'none' : 'unknown'; if (t.question?.status === 'pending') t.question.status = 'expired'; });
    } finally { live.delete(id); starting.delete(id); try { await engine?.close(); } catch {} }
  }
  async function answer(id) {
    const entry = live.get(id); if (!entry || entry.answering || stopped) return;
    entry.answering = true;
    try {
      const t = read(id), q = t.question;
      if (t.phase !== 'answer_pending' || !q?.response) return;
      fact(id, current => { current.phase = 'submitting'; current.delivery = 'attempting'; });
      checkpoint('before_local_answer');
      await entry.engine.respond(t.nativeId, { optionLabels: q.response.optionIds.map(id => q.options.find(o => o.id === id).label), text: q.response.text });
      checkpoint('after_local_answer');
      fact(id, current => { if (current.question?.id !== q.id) return; if (current.phase === 'submitting') current.phase = 'running'; current.delivery = 'submitted'; });
    } catch { fact(id, t => { t.phase = 'unknown'; t.delivery = 'unknown'; }); try { await entry.engine.close(); } catch {} }
    finally { entry.answering = false; }
  }
  return {
    apply, read, view,
    list: roomId => db.prepare('SELECT state_json FROM local_tasks WHERE room_id=? ORDER BY rowid DESC LIMIT 100').all(roomId).map(r => view(JSON.parse(r.state_json))),
    recover() { for (const row of db.prepare('SELECT state_json FROM local_tasks').all()) { const t = JSON.parse(row.state_json); if (['queued', 'dispatching', 'running', 'awaiting_input', 'answer_pending', 'submitting'].includes(t.phase)) fact(t.id, current => { current.phase = current.phase === 'queued' ? 'paused' : 'unknown'; if (current.question?.status === 'pending') current.question.status = 'expired'; if (['pending', 'attempting'].includes(current.delivery)) current.delivery = 'unknown'; }); } },
    schedule(id) { if (!configuration || stopped) return; queueMicrotask(() => { if (stopped) return; const t = read(id); if (t.phase === 'queued') void start(id).catch(() => {}); else if (t.phase === 'answer_pending') void answer(id).catch(() => {}); }); },
    shutdown() { stopped = true; for (const { engine } of live.values()) void engine.close().catch(() => {}); live.clear(); },
  };
}
