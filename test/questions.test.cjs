const { test } = require('node:test');
const assert = require('node:assert/strict');
async function setup() {
  const { createMockTransport } = await import('../renderer/client/mock.mjs');
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const { transport, control } = createMockTransport({ manual: true });
  const client = createAgentRoomClient(transport); await client.open(); control.question('room-design');
  return { transport, control, client, q: client.read().questions[0] };
}
test('question answers validate IDs, cardinality and revision, and record once through the Client', async () => {
  const { transport, control, client, q } = await setup();
  try {
    const c = { type: 'answerQuestion', key: 'answer-1', questionId: q.id, expectedRevision: 0, optionIds: ['keep'], text: '只保留两周' };
    await assert.rejects(client.dispatch({ ...c, optionIds: ['missing'] }), { code: 'invalid_answer' });
    await assert.rejects(client.dispatch({ ...c, optionIds: ['keep', 'switch'] }), { code: 'invalid_answer' });
    await assert.rejects(client.dispatch({ ...c, optionIds: [], text: ' ' }), { code: 'invalid_answer' });
    const r = await client.dispatch(c); assert.equal(client.read().questions[0].response.text, '只保留两周');
    assert.deepEqual(await client.dispatch(c), r);
    await assert.rejects(client.dispatch({ ...c, text: 'changed' }), { code: 'conflict' });
    assert.equal(client.read().questions[0].revision, 1);
    assert.equal((await transport.snapshot()).approvals.length, 0);
  } finally { client.close(); control.dispose(); }
});
test('unknown answer blocks new key until original receipt is checked; reset and revisions isolate answers', async () => {
  const { control, client, q } = await setup();
  try {
    const c = { type: 'answerQuestion', key: 'unknown-1', questionId: q.id, expectedRevision: 0, optionIds: [], text: '自由输入' };
    control.questionFailure('unknown');
    await assert.rejects(client.dispatch(c), { outcome: 'unknown' });
    await assert.rejects(client.dispatch({ ...c, key: 'new-key' }), { code: 'outcome_unknown' });
    assert.equal((await client.query({ type: 'questionOperation', questionId: q.id, key: c.key })).found, true);
    assert.equal(client.read().questions[0].response.authorId, 'user');
    control.question('room-code', true); const next = client.read().questions.at(-1);
    control.questionChange('revision');
    await assert.rejects(client.dispatch({ ...c, key: 'stale', questionId: next.id }), { code: 'conflict' });
    await client.dispatch({ ...c, key: 'multi', questionId: next.id, expectedRevision: 1, optionIds: ['keep', 'later'] });
    control.reset(); assert.equal(client.read().questions.length, 0);
  } finally { client.close(); control.dispose(); }
});
test('legacy transport cannot receive collaboration commands', async () => {
  const { transport, control, client, q } = await setup(); client.close();
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs'); let calls = 0;
  const legacy = createAgentRoomClient({ ...transport, snapshot: async () => { const s = await transport.snapshot(); s.capabilities.collaborationQuestions = false; return s; }, command: () => { calls++; } });
  try { await legacy.open(); await assert.rejects(legacy.dispatch({ type: 'answerQuestion', key: 'no', questionId: q.id, expectedRevision: 0, optionIds: ['keep'], text: '' }), { code: 'unsupported' }); assert.equal(calls, 0); }
  finally { legacy.close(); control.dispose(); }
});
