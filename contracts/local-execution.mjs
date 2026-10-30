import { z } from 'zod';
const id = z.string().min(1).max(300);
const revision = z.number().int().nonnegative();
const base = { workspaceId: id, roomId: id, key: id };
export const localExecutionCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('createLocalTask'), ownerAgentId: id, goal: z.string().trim().min(1).max(16000) }).strict(),
  z.object({ ...base, type: z.literal('answerLocalQuestion'), taskId: id, questionId: id, expectedRevision: revision, optionIds: z.array(id).max(20), text: z.string().max(4000) }).strict(),
]);
export const localExecutionQuerySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('localTasks'), roomId: id }).strict(),
  z.object({ type: z.literal('localTask'), roomId: id, taskId: id }).strict(),
]);
export const localQuestionSchema = z.object({ id, revision, title: z.string(), multiple: z.boolean(), options: z.array(z.object({ id, label: z.string() })), status: z.enum(['pending', 'answered', 'expired']), response: z.object({ authorId: id, optionIds: z.array(id), text: z.string() }).nullable() });
export const localTaskSchema = z.object({
  id, runId: id, initiatorId: id, roomId: id, ownerAgentId: id, goal: z.string(), revision: revision.positive(),
  phase: z.enum(['queued', 'dispatching', 'running', 'awaiting_input', 'answer_pending', 'submitting', 'reviewing', 'failed', 'unknown', 'paused']),
  result: z.string().max(16000), delivery: z.enum(['none', 'pending', 'attempting', 'submitted', 'unknown']),
  question: localQuestionSchema.nullable(), history: z.array(localQuestionSchema),
});
