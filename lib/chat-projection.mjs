// Private migration projection: engine and hcom fields never cross the chat transport.
export function createChatProjection() {
  let fallbackRevision = 0;
  const started = new Map();
  const turns = new Map();
  return function normalize(raw) {
    const agents = (raw.agents || []).map(a => ({ id: a.id, name: a.name, displayName: a.displayName || a.name, engine: a.label || a.tool, status: a.status || 'unknown', workspaceId: a.workspaceId }));
    const rooms = [
      ...(raw.rooms || []).map(r => ({ id: r.id, title: r.title, type: 'group', workspaceId: r.workspaceId, memberIds: agents.filter(a => a.workspaceId === r.workspaceId && (r.allMembers || r.members?.includes(a.id))).map(a => a.id), ownerAgentId: null, pinned: Boolean(r.pinned), description: r.description || '', thread: r.thread })),
      ...agents.map(a => ({ id: `dm:${a.id}`, title: a.displayName, type: 'dm', workspaceId: a.workspaceId, memberIds: [a.id], ownerAgentId: a.id, thread: `agent-room-dm-${a.id}` })),
    ];
    const roomFor = thread => rooms.find(r => r.thread === thread)?.id;
    const toolsFor = (a, turn) => (a?.rpc?.tools || []).filter(t => t.turnId === String(turn)).map(t => ({ id: t.id, name: t.kind, status: t.status, detail: t.detail || '', output: t.output || '', patches: (t.diffs || []).filter(d => d.patch).map(d => d.patch) }));
    const replyId = (agent, turn) => `reply:${agent}:${turn}`;
    const publicId = m => {
      const agent = raw.agents.find(a => a.id === m.sender || a.name === m.sender);
      return !m.human && m.replyTo ? replyId(agent?.id || m.sender, m.replyTo) : `message:${m.id}`;
    };
    const messageIds = new Map((raw.messages || []).map(m => [String(m.id), publicId(m)]));
    const messages = (raw.messages || []).flatMap((m, index) => {
      const roomId = roomFor(m.thread); if (!roomId) return [];
      const agent = raw.agents.find(a => a.id === m.sender || a.name === m.sender);
      const id = !m.human && m.replyTo ? replyId(agent?.id || m.sender, m.replyTo) : `message:${m.id}`;
      return [{ id, roomId, sequence: Number(m.id) || index + 1, role: m.human ? 'user' : 'assistant', authorId: agent?.id || m.sender || 'user', authorName: m.senderName || agent?.displayName || '你', text: m.text || '', status: 'complete', createdAt: m.timestamp || '', tools: m.human ? [] : toolsFor(agent, m.replyTo), replyToId: messageIds.get(String(m.replyTo)) || null, recipientIds: m.recipients || [] }];
    });
    for (const a of raw.agents || []) {
      if (a.rpc?.current) turns.set(a.id, { ...a.rpc.current, sessionId: a.sessionId });
      const previous = turns.get(a.id);
      const retained = previous?.sessionId === a.sessionId ? previous : null;
      const current = a.rpc?.current || (a.rpc?.error ? a.rpc.lastTurn || retained : null), roomId = roomFor(current?.thread);
      if (!a.rpc?.current && !a.rpc?.error) turns.delete(a.id);
      if (!current || !roomId) continue;
      const id = replyId(a.id, current.id);
      if (messages.some(m => m.id === id)) continue;
      if (!started.has(id)) started.set(id, new Date().toISOString());
      messages.push({ id, roomId, sequence: Number(current.id) + 0.5, role: 'assistant', authorId: a.id, authorName: a.displayName || a.name,
        text: a.rpc.partial || a.rpc.error || '', status: a.rpc.error ? 'unknown' : 'running', createdAt: started.get(id), tools: toolsFor(a, current.id) });
    }
    messages.sort((a, b) => a.sequence - b.sequence);
    for (const agentId of turns.keys()) if (!agents.some(a => a.id === agentId)) turns.delete(agentId);
    const visibleIds = new Set(messages.map(m => m.id));
    for (const id of started.keys()) if (!visibleIds.has(id)) started.delete(id);
    const approvals = (raw.agents || []).flatMap(a => (a.rpc?.approvals || []).map(r => {
      const d = r.data || {}, questions = d.questions || d.input?.questions || [];
      const details = Object.fromEntries(['command', 'description', 'message', 'permission', 'tool_name', 'cwd', 'paths', 'changes', 'permissions', 'input', 'tool_input'].filter(key => d[key] !== undefined).map(key => [key, d[key]]));
      const summary = Object.entries(details).map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}`).join('\n');
      return { id: r.id, agentId: a.id, roomId: roomFor(r.thread || a.rpc.current?.thread) || '', revision: 0, kind: r.kind,
        title: String(r.title || d.title || '操作需要确认'), summary: summary || r.title || '引擎请求确认',
        scopeLabel: r.grantScope === 'turn' || d.method === 'item/permissions/requestApproval' ? '当前任务轮次' : '仅本次操作', directory: r.directory || a.directory || '',
        questions: questions.map((q, i) => ({ id: q.id || String(i), title: q.question || q.header || '请回答', multiple: Boolean(q.multiSelect || q.multiple), options: (q.options || []).map(o => typeof o === 'string' ? o : o.label) })),
        options: d.method === 'select' ? (d.options || []).map(String) : [],
      };
    }));
    return { instanceId: raw.sync?.instanceId || 'legacy-session', revision: raw.sync?.revision ?? ++fallbackRevision, agents,
      rooms: rooms.map(({ thread, ...r }) => r), workspaces: raw.workspaces || [], messages, approvals, capabilities: { tasks: false, idempotentSend: false } };
  };
}
