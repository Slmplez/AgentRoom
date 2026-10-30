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
test('question receipt verification rejects a mismatched operation instead of clearing uncertain protection', async () => {
  const { transport, control, client, q } = await setup(); client.close();
  const { createAgentRoomClient } = await import('../renderer/client/client.mjs');
  const scoped = createAgentRoomClient({ ...transport, query: async input => ({ found: true, key: input.key, questionId: 'another-question' }) });
  try {
    await scoped.open(); control.questionFailure('unknown');
    const c = { type: 'answerQuestion', key: 'receipt-scope', questionId: q.id, expectedRevision: 0, optionIds: ['keep'], text: '' };
    await assert.rejects(scoped.dispatch(c), { outcome: 'unknown' });
    await assert.rejects(scoped.query({ type: 'questionOperation', key: c.key, questionId: q.id }), { code: 'invalid_response' });
    await assert.rejects(scoped.dispatch({ ...c, key: 'new-key' }), { code: 'outcome_unknown' });
  } finally { scoped.close(); control.dispose(); }
});
test('advice only targets explicit room agents; multiple replies do not decide for the human or change owner', async () => {
  const { control, client, q } = await setup();
  try {
    const request = { type: 'requestQuestionAdvice', key: 'consult', questionId: q.id, expectedRevision: 0, expectedAdviceGeneration: 0, agentIds: ['beta', 'gamma'], instruction: '请分析兼容影响' };
    await assert.rejects(client.dispatch({ ...request, agentIds: ['stranger'] }), { code: 'invalid_recipient' });
    await assert.rejects(client.dispatch({ ...request, agentIds: ['beta', 'beta'] }), { code: 'invalid_recipient' });
    await client.dispatch(request); control.duplicate();
    assert.equal(client.read().questions[0].advices.length, 2);
    assert.equal(client.read().runs.length, 0);
    control.adviceResults();
    const answered = client.read().questions[0]; assert.equal(answered.status, 'pending'); assert.equal(answered.response, null);
    assert.deepEqual(answered.advices.map(a => a.agentId), ['beta', 'gamma']);
    const adoption = { type: 'adoptQuestionAdvice', key: 'adopt', questionId: q.id, expectedRevision: 0, expectedAdviceGeneration: 1, adviceId: answered.advices[0].id };
    await client.dispatch(adoption);
    assert.equal(client.read().questions[0].response.authorId, 'user');
    assert.equal(client.read().questions[0].response.adoptedAdviceId, adoption.adviceId);
    assert.equal(client.read().rooms.find(r => r.id === 'room-design').ownerAgentId, 'alpha');
    await assert.rejects(client.dispatch({ ...adoption, key: 'compete' }), { code: 'expired' });
  } finally { client.close(); control.dispose(); }
});
test('reassignment, failed/unknown and late old answers cannot satisfy current decision; unknown request is checked', async () => {
  const { control, client, q } = await setup();
  try {
    const c = { type: 'requestQuestionAdvice', key: 'first', questionId: q.id, expectedRevision: 0, expectedAdviceGeneration: 0, agentIds: ['beta'], instruction: '' };
    control.questionFailure('unknown'); await assert.rejects(client.dispatch(c), { outcome: 'unknown' });
    await assert.rejects(client.dispatch({ type: 'answerQuestion', key: 'bypass', questionId: q.id, expectedRevision: 0, optionIds: [], text: '绕过核查' }), { code: 'outcome_unknown' });
    await client.query({ type: 'questionOperation', key: c.key, questionId: q.id });
    const old = client.read().questions[0].advices[0].id;
    await client.dispatch({ ...c, key: 'second', expectedAdviceGeneration: 1, agentIds: ['gamma'] }); control.adviceResults('late');
    await assert.rejects(client.dispatch({ type: 'adoptQuestionAdvice', key: 'late', questionId: q.id, expectedRevision: 0, expectedAdviceGeneration: 2, adviceId: old }), { code: 'conflict' });
    control.adviceResults('failed'); assert.equal(client.read().questions[0].advices.at(-1).status, 'failed');
    await client.dispatch({ ...c, key: 'third', expectedAdviceGeneration: 2, agentIds: ['gamma'] }); control.adviceResults('unknown');
    assert.equal(client.read().questions[0].status, 'pending');
    await client.dispatch({ ...c, key: 'fourth', expectedAdviceGeneration: 3, agentIds: ['gamma'] }); control.adviceMemberLeft();
    assert.equal(client.read().questions[0].advices.at(-1).status, 'revoked');
    const snap = client.read().questions[0];
    await assert.rejects(client.dispatch({ type: 'adoptQuestionAdvice', key: 'left', questionId: q.id, expectedRevision: 0, expectedAdviceGeneration: 4, adviceId: snap.advices.at(-1).id }), { code: 'conflict' });
    control.approval('permission'); const pendingApproval = client.read().approvals[0];
    await client.dispatch({ type: 'answerQuestion', key: 'human', questionId: q.id, expectedRevision: 0, optionIds: ['keep'], text: '我来补充' });
    assert.equal(client.read().approvals[0].id, pendingApproval.id);
    assert.equal(client.read().approvals[0].status, 'pending');
  } finally { client.close(); control.dispose(); }
});
