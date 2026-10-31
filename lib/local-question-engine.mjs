import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createEngine } = require('./rpc/engines.cjs');

// Trusted host assembly only: no request body controls args, directory or env.
export function createPiQuestionEngine({ directory, env = process.env, args = [], command, executionTag }) {
  if (executionTag && !/^[a-f0-9-]{36}$/.test(executionTag)) throw Error('Invalid trusted execution tag.');
  const raw = createEngine({ tool: 'pi', directory, env, command, args: ['--no-extensions', '--no-skills', '--no-prompt-templates', '--no-themes', '--tools', 'read,grep,find,ls', ...args], instructions: 'You are a read-only local assistant. Do not modify files or run commands. Ask for clarification through the available UI input extension when needed.' + (executionTag ? `\nProcess identity: AGENTROOM_EXECUTION_${executionTag}` : '') });
  let listener;
  raw.on('approval', request => {
    try {
      if (request.kind === 'permission') throw new Error('Execution permission is unavailable in the read-only local slice.');
      const list = request.data.questions;
      if (list && list.length !== 1) throw new Error('Only one native question at a time is supported.');
      const q = list?.[0] || request.data;
      listener?.({ id: request.id, title: q.question || q.title || q.message || '请补充信息', multiple: Boolean(q.multiSelect || q.multiple), options: (q.options || []).map(o => typeof o === 'string' ? o : o.label) });
    } catch (e) { raw.fail(e); }
  });
  return {
    onQuestion(callback) { listener = callback; },
    cancel: () => raw.cancel(),
    isStopped: () => !raw.pipe.child || raw.pipe.exited === true,
    start: () => raw.start(),
    async prompt(goal) { if (raw.failure) throw raw.failure; try { const text = await raw.prompt(goal); return { text, outcome: raw.lastOutcome || 'unknown' }; } catch(error) { error.outcome = raw.lastOutcome || 'unknown'; throw error; } },
    async respond(id, answer) {
      const request = raw.requests.get(String(id)); if (!request) throw new Error('Native input request expired.');
      const values = [...answer.optionLabels, answer.text].filter(Boolean);
      await raw.respond(id, { value: values.join('\n'), answers: [values], allow: false });
    },
    close: () => raw.close(),
  };
}
