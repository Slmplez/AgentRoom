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
      if (c.type !== 'answerQuestion' && c.expectedAdviceGeneration !== q.adviceGeneration) throw clientError('conflict', '咨询已更新，请重新查看接收者。');
      const room = read().rooms.find(r => r.id === q.roomId);
      let advice;
      if (c.type === 'requestQuestionAdvice') {
        if (new Set(c.agentIds).size !== c.agentIds.length || c.agentIds.some(id => !room.memberIds.includes(id) || !read().agents.some(a => a.id === id))) throw clientError('invalid_recipient', '请选择当前房间的 Agent，且不能重复。');
      } else if (c.type === 'adoptQuestionAdvice') {
        advice = q.advices.find(a => a.id === c.adviceId && a.generation === q.adviceGeneration && a.questionRevision === q.revision && a.status === 'answered' && room.memberIds.includes(a.agentId));
        if (!advice) throw clientError('conflict', '该建议已失效，不能采纳。');
      }
      const optionIds = advice?.optionIds || c.optionIds, text = advice?.text || c.text;
      if (c.type !== 'requestQuestionAdvice') {
        const unique = new Set(optionIds);
        if (unique.size !== optionIds.length || (!q.multiple && unique.size > 1) || optionIds.some(id => !q.options.some(o => o.id === id)) || (!unique.size && !text.trim())) throw clientError('invalid_answer', '请选择选项或输入有效答复。');
      }
      const mode = fail; fail = '';
      if (mode === 'reject') throw clientError('rejected', '模拟提交失败，填写内容已保留。');
      if (c.type === 'requestQuestionAdvice') {
        q.advices.forEach(a => { if (a.status === 'waiting') a.status = 'revoked'; });
        q.adviceGeneration++;
        q.advices.push(...c.agentIds.map(agentId => ({ id: `advice-${q.id}-${q.adviceGeneration}-${agentId}`, agentId, generation: q.adviceGeneration, questionRevision: q.revision, status: 'waiting', instruction: c.instruction, text: '', optionIds: [] })));
      } else {
        q.response = { key: c.key, authorId: read().currentUserId, optionIds, text: text.trim(), adoptedAdviceId: advice?.id || null };
        q.status = 'resolved'; q.revision++;
        q.advices.forEach(a => { if (a.status === 'waiting') a.status = 'revoked'; });
      }
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
        options: [{ id: 'keep', label: '保留兼容' }, { id: 'switch', label: '直接切换新接口' }, { id: 'later', label: '暂不决定' }], status: 'pending', canAnswer: true, response: null, adviceGeneration: 0, advices: [] }); publish();
    },
    fail(mode) { fail = mode; },
    results(mode = 'answered') {
      const q = read().questions.at(-1); if (!q) return;
      for (const a of q.advices) {
        if (mode === 'late' ? a.generation >= q.adviceGeneration : a.status !== 'waiting') continue;
        a.status = mode === 'late' ? 'answered' : mode;
        a.text = a.status === 'answered' ? '建议保留兼容两周，再按调用方迁移情况移除。' : mode === 'failed' ? '模拟分析失败，可重新指派。' : '模拟建议接收结果未知，请核查后再处理。';
        a.optionIds = a.status === 'answered' ? ['keep'] : [];
      }
      publish();
    },
    memberLeft() {
      const q = read().questions.at(-1); if (!q) return;
      const id = q.advices.at(-1)?.agentId; const room = read().rooms.find(r => r.id === q.roomId);
      if (id) { room.memberIds = room.memberIds.filter(member => member !== id); q.advices.filter(a => a.agentId === id).forEach(a => { a.status = 'revoked'; }); }
      publish();
    },
    change(mode) {
      const q = read().questions.at(-1); if (!q) return;
      if (mode === 'revision') { q.revision++; q.title = '请确认最新的兼容策略'; }
      else if (mode === 'other') { q.status = 'resolved'; q.revision++; q.response = { key: 'other', authorId: 'another-user', optionIds: ['keep'], text: '已由其他成员答复' }; }
      else { q.status = mode === 'revoke' ? 'revoked' : 'expired'; q.canAnswer = false; q.revision++; }
      publish();
    },
  };
}
