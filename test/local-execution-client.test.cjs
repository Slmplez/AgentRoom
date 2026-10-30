const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const until = async read => { const end = Date.now() + 6000; while (!await read()) { if (Date.now() > end) throw Error('Client state did not arrive'); await new Promise(r => setTimeout(r, 15)); } };
function storage() { const data = new Map(); return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k), key: i => [...data.keys()][i] ?? null, get length() { return data.size; } }; }
test('two public clients project native tasks, lost answer receipt is checked across reload without resending', async () => {
  const { createApplicationRuntime } = await import('../lib/application-runtime/index.mjs');
  const { startPersistenceHttp } = await import('../lib/application-http/index.mjs');
  const { createPiQuestionEngine } = await import('../lib/local-question-engine.mjs');
  const { createPersistentTransport } = await import('../renderer/client/persistent.mjs');
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentroom-local-client-'));
  let runtime = await createApplicationRuntime({ directory, execution: { agentId: 'local-pi', createEngine: () => createPiQuestionEngine({ directory, env: process.env, command: { command: process.execPath, args: [path.join(__dirname, 'fixtures/local-question-pi.cjs')] } }) } });
  let http = await startPersistenceHttp({ runtime }); const journal = storage(), clients = []; let answers = 0, lose = true;
  const boot = runtime.query({ type: 'bootstrap' }, runtime.owner), workspaceId = boot.workspace.id;
  const roomId = runtime.execute({ type: 'createRoom', workspaceId, key: 'room', title: 'Clients' }, runtime.owner).roomId;
  const make = async (ownStorage = journal) => {
    const transport = createPersistentTransport({ backendId: 'backend', localUserId: 'local', storage: ownStorage, session: async () => ({ origin: http.origin, token: http.token }), fetch: async (url, options) => {
      const response = await fetch(url, options);
      if (options.method === 'POST' && url.endsWith('/answers')) { answers++; if (lose) { lose = false; await response.body.cancel(); throw Error('Lost original response'); } }
      return response;
    } });
    const client = createAgentRoomClient(transport); clients.push(client); await client.open({ roomId }); return client;
  };
  try {
    const a = await make(), b = await make(storage());
    assert.equal(a.read().capabilities.localExecution, true); assert.equal(a.read().capabilities.tasks, false);
    const created = await a.dispatch({ type: 'createLocalTask', key: 'task', workspaceId, roomId, ownerAgentId: 'local-pi', goal: '客户端问答' });
    await until(() => b.read().localTasks[0]?.phase === 'awaiting_input');
    const task = b.read().localTasks[0], q = task.question;
    assert.equal(task.id, created.taskId);
    await assert.rejects(a.dispatch({ type: 'answerLocalQuestion', key: 'answer', workspaceId, roomId, taskId: task.id, questionId: q.id, expectedRevision: 0, optionIds: [], text: '两周' }), { outcome: 'unknown' });
    assert.equal(a.read().pendingOperations[0].taskId, task.id);
    await assert.rejects(a.dispatch({ type: 'answerLocalQuestion', key: 'wrong-new-key', workspaceId, roomId, taskId: task.id, questionId: q.id, expectedRevision: 0, optionIds: [], text: '两周' }), { code: 'outcome_unknown' });
    await until(() => b.read().localTasks[0]?.phase === 'reviewing');
    a.close(); const reloaded = await make();
    assert.equal(reloaded.read().localTasks[0].result, '已继续：两周');
    assert.equal(reloaded.read().pendingOperations.length, 0); assert.equal(answers, 1);
    assert.equal(reloaded.read().currentUserId, boot.user.id);
    assert.equal(reloaded.read().backendId, 'backend');
    await http.close(); runtime.close();
    runtime = await createApplicationRuntime({ directory }); http = await startPersistenceHttp({ runtime });
    await reloaded.open({ roomId });
    assert.equal(reloaded.read().capabilities.localExecution, false, 'Resume must reflect revoked execution capability without requiring a new snapshot');
    assert.equal(reloaded.read().localAgentId, null);
    assert.equal(reloaded.read().localTasks[0].phase, 'reviewing');
  } finally { clients.forEach(c => c.close()); await http.close(); runtime.close(); }
});
