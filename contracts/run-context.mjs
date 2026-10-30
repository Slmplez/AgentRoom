import { z } from 'zod';
import { memoryScopeSchema, soulContentSchema, MEMORY_LIMITS } from './agent-memory.mjs';

const id = z.string().min(1).max(300);
const revision = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const contextMemorySchema = z.object({
  id, scope: memoryScopeSchema, revision,
  text: z.string().refine(value => value.trim().length > 0 && [...value].length <= MEMORY_LIMITS.text),
  sourceIds: z.array(id).min(1),
}).strict();
export const runContextSnapshotSchema = z.object({
  snapshotId: id, formatVersion: z.literal(1), taskId: id, runId: id, agentId: id, roomId: id,
  createdAt: z.string(), soulRevision: revision.nullable(), soul: soulContentSchema.nullable(),
  memories: z.array(contextMemorySchema).max(MEMORY_LIMITS.perScope * 2),
  contextText: z.string(), prompt: z.string(),
}).strict().superRefine((snapshot, ctx) => {
  if ((snapshot.soul === null) !== (snapshot.soulRevision === null) ||
      new Set(snapshot.memories.map(row => row.id)).size !== snapshot.memories.length ||
      ['agent', 'room'].some(kind => snapshot.memories.filter(row => row.scope.kind === kind).length > MEMORY_LIMITS.perScope) ||
      snapshot.memories.some(row => row.scope.kind === 'agent' ? row.scope.agentId !== snapshot.agentId : row.scope.roomId !== snapshot.roomId)) {
    ctx.addIssue({ code: 'custom', message: 'Context identity or scope mismatch.' });
  }
});
export const taskContextQuerySchema = z.object({ type: z.literal('taskContextSnapshot'), roomId: id, taskId: id }).strict();
export const taskContextResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), snapshot: runContextSnapshotSchema }).strict(),
  z.object({ status: z.enum(['not_started', 'not_recorded']), taskId: id, runId: id, snapshot: z.null() }).strict(),
]);
