import { z } from 'zod';
const id = z.string().min(1).max(300);
export const questionResponseSchema = z.object({ key: id, authorId: id, optionIds: z.array(id), text: z.string().max(4000) });
export const collaborationQuestionSchema = z.object({
  id, revision: z.number().int().nonnegative(), roomId: id, sourceMessageId: id, authorId: id, recipientId: id,
  title: z.string().min(1).max(500), description: z.string().max(4000), multiple: z.boolean(),
  options: z.array(z.object({ id, label: z.string().min(1).max(300) })).max(20),
  status: z.enum(['pending', 'resolved', 'expired', 'revoked']), canAnswer: z.boolean(),
  response: questionResponseSchema.nullable().default(null),
});
export const questionCommands = [z.object({ type: z.literal('answerQuestion'), key: id, questionId: id, expectedRevision: z.number().int().nonnegative(), optionIds: z.array(id).max(20), text: z.string().max(4000) })];
export const questionQueries = [z.object({ type: z.literal('questionOperation'), key: id, questionId: id })];
export const questionQueryResults = { questionOperation: z.object({ found: z.boolean(), key: id, questionId: id }) };
