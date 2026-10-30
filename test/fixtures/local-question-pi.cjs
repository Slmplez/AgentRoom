const readline = require('node:readline');
const input = readline.createInterface({ input: process.stdin });
const fs = require('node:fs');
if (process.env.LOCAL_ANSWER_LOG) fs.appendFileSync(process.env.LOCAL_ANSWER_LOG, 'start\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
input.on('line', line => {
  const r = JSON.parse(line);
  if (r.type === 'get_state') send({ type: 'response', id: r.id, success: true, data: { sessionId: 'controlled-native-session' } });
  if (r.type === 'prompt') {
    send({ type: 'response', id: r.id, success: true, data: {} });
    send({ type: 'extension_ui_request', id: 'native-input', method: r.message.includes('select') ? 'select' : 'input', title: '旧接口兼容期限？', ...(r.message.includes('select') ? { options: ['保留两周', '直接切换'] } : {}) });
  }
  if (r.type === 'extension_ui_response') {
    if (process.env.LOCAL_ANSWER_LOG) fs.appendFileSync(process.env.LOCAL_ANSWER_LOG, 'answer\n');
    send({ type: 'message_start', message: { role: 'assistant' } });
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: `已继续：${r.value}` }], stopReason: 'stop' } });
    send({ type: 'agent_settled' });
  }
});
