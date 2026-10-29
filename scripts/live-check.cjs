// Explicit, bounded acceptance check against an existing demo agent.
const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: pause } = require('node:timers/promises');
const { HcomService } = require('../lib/hcom-service.cjs');
(async () => {
  const agentName = process.argv[2];
  if (!agentName || process.argv.length !== 3) throw new Error('Usage: node scripts/live-check.cjs <agent-name>. Sends one real message to that running agent.');
  const service = new HcomService();
  try {
    await service.start();
    const initial = service.snapshot();
    if (initial.connection !== 'connected') throw new Error('hcom is not connected');
    const agent = initial.agents.find(agent => agent.name === agentName);
    if (!agent) throw new Error('The specified agent is not running; no message was sent.');
    const room = initial.rooms.find(room => room.workspaceId === agent.workspaceId && room.pinned);
    const result = await service.send({ roomId: room.id, text: `@${agent.name} 桌面界面连通性检查：请只通过 hcom 回复「桌面群聊已连通」，不要执行其他任务，也不要再发起消息。` });
    if (result.targets.length !== 1 || result.targets[0] !== agent.id) throw new Error('Unexpected recipients');
    console.log(`Sent one acceptance message, hcom event #${result.receipt.event_id}; waiting for reply.`);
    let reply;
    for (let attempt = 0; attempt < 45; attempt++) {
      await pause(1500);
      await service.refresh();
      reply = service.snapshot().messages.find(message => message.sender === agent.id && message.replyTo === String(result.receipt.event_id));
      if (reply) break;
    }
    if (!reply) throw new Error('No correlated reply within the check window. Do not resend automatically.');
    const evidence = { timestamp: new Date().toISOString(), connection: initial.connection, enginesListed: initial.engines.length,
      discoveredAgents: initial.agents.map(agent => ({ id: agent.id, name: agent.name, tool: agent.tool, workspaceId: agent.workspaceId })),
      requestEvent: result.receipt.event_id, targets: result.targets, replyEvent: reply.id, replyText: reply.text, thread: reply.thread };
    await fs.mkdir(path.join(__dirname, '..', 'artifacts'), { recursive: true });
    await fs.writeFile(path.join(__dirname, '..', 'artifacts', 'live-bridge-check.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  } finally { service.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
