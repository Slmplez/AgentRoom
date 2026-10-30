import { clientError } from '../../contracts/chat.mjs';

// Scenario state lives in the transport's snapshot, never in a second UI store.
export function createMockQuestions(read, publish, message) {
  const receipts = new Map(); let number = 0, fail = '';
  function find(id) {
    const state = read(), q = state.questions.find(q => q.id === id);
    if (!q || !state.rooms.some(r => r.id === q.roomId && r.memberIds.includes(q.authorId))) throw clientError('not_found', '问题不可访问。');
    return q;
  }
  return {
    execute(c) {
      const q = find(c.questionId), digest = JSON.stringify(c), old = receipts.get(c.key);
      if (old) { if (old.digest !== digest) throw clientError('conflict', '同一请求标识不能提交不同答复。'); return old.receipt; }
      if (!q.canAnswer || q.recipientId !== read().currentUserId) throw clientError('forbidden', '当前成员不能回答这个问题。');
      if (q.status !== 'pending') throw clientError('expired', '问题已处理或失效。');
      if (q.revision !== c.expectedRevision) throw clientError('conflict', '问题已变化，请核对最新版本。');
      const unique = new Set(c.optionIds);
      if (unique.size !== c.optionIds.length || (!q.multiple && unique.size > 1) || c.optionIds.some(id => !q.options.some(o => o.id === id)) || (!unique.size && !c.text.trim())) throw clientError('invalid_answer', '请选择选项或输入有效答复。');
      const mode = fail; fail = '';
      if (mode === 'reject') throw clientError('rejected', '模拟提交失败，填写内容已保留。');
      q.response = { key: c.key, authorId: read().currentUserId, optionIds: c.optionIds, text: c.text.trim() };
      q.status = 'resolved'; q.revision++;
      const receipt = { accepted: true, operationId: `answer-${c.key}`, entityId: q.id };
      receipts.set(c.key, { digest, receipt, questionId: q.id });
      if (mode === 'unknown') throw clientError('outcome_unknown', '答复接收结果未知，请核查原请求。', 'unknown');
      publish(); return receipt;
    },
    query(c) { find(c.questionId); const entry = receipts.get(c.key); const found = entry?.questionId === c.questionId; if (found) publish(); return { found: Boolean(found), key: c.key, questionId: c.questionId }; },
    reset() { receipts.clear(); number = 0; fail = ''; },
    create(roomId, multiple = false) {
      const room = read().rooms.find(r => r.id === roomId) || read().rooms[0]; if (!room) return;
      const m = message(room.id, room.memberIds[0], '检查完成，发现 3 个问题，其中 1 个需要你确认。');
      read().questions.push({ id: `question-${read().instanceId}-${++number}`, revision: 0, roomId: room.id, sourceMessageId: m.id, authorId: room.memberIds[0], recipientId: 'user', title: '是否保留旧接口兼容？', description: '保留兼容可以避免现有客户端受到影响。此处仅演示问答，不执行实际任务。', multiple,
        options: [{ id: 'keep', label: '保留兼容' }, { id: 'switch', label: '直接切换新接口' }, { id: 'later', label: '暂不决定' }], status: 'pending', canAnswer: true, response: null }); publish();
    },
    fail(mode) { fail = mode; },
    change(mode) {
      const q = read().questions.at(-1); if (!q) return;
      if (mode === 'revision') { q.revision++; q.title = '请确认最新的兼容策略'; }
      else if (mode === 'other') { q.status = 'resolved'; q.revision++; q.response = { key: 'other', authorId: 'another-user', optionIds: ['keep'], text: '已由其他成员答复' }; }
      else { q.status = mode === 'revoke' ? 'revoked' : 'expired'; q.canAnswer = false; q.revision++; }
      publish();
    },
  };
}
