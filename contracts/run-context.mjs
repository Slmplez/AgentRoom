import { z } from 'zod';
import { memoryScopeSchema, sameMemoryScope, soulContentSchema, MEMORY_LIMITS, MEMORY_CONTEXT_LIMITS as B } from './agent-memory.mjs';
import { curatedEntrySchema, CURATION_LIMITS } from './memory-curation.mjs';

const id = z.string().min(1).max(300);
const count = z.number().int().nonnegative().safe(), revision = count.positive();
const boundedText = maximum => z.string().refine(value => value.trim().length > 0 && [...value].length <= maximum);
export const contextMemorySchema = z.object({ id, scope: memoryScopeSchema, revision, text: boundedText(MEMORY_LIMITS.text), sourceIds: z.array(id).min(1) }).strict();
const reference = z.object({ id, revision }).strict();
export const memoryContextSchema = z.object({
  scope: memoryScopeSchema, headRevision: count, deferred: count, stale: count, characters: count.max(B.characters),
  items: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('record'), text: boundedText(MEMORY_LIMITS.text), refs: z.array(reference).length(1) }).strict(),
    curatedEntrySchema.extend({ kind: z.literal('summary') }),
  ])).max(B.perScope),
}).strict().superRefine((context, ctx) => {
  const refs = context.items.flatMap(item => item.refs);
  if (refs.length > CURATION_LIMITS.provenance || context.characters !== context.items.reduce((n, item) => n + [...item.text].length, 0) || new Set(refs.map(ref => ref.id)).size !== refs.length) ctx.addIssue({ code: 'custom', message: 'Context budget or provenance mismatch.' });
});
const base = {
  snapshotId: id, taskId: id, runId: id, agentId: id, roomId: id, createdAt: z.string(),
  soulRevision: revision.nullable(), soul: soulContentSchema.nullable(), contextText: z.string(), prompt: z.string(),
};
const checkIdentity = (snapshot, ctx) => {
  if ((snapshot.soul === null) !== (snapshot.soulRevision === null) ||
      new Set(snapshot.memories.map(row => row.id)).size !== snapshot.memories.length ||
      ['agent', 'room'].some(kind => snapshot.memories.filter(row => row.scope.kind === kind).length > 16) ||
      snapshot.memories.some(row => row.scope.kind === 'agent' ? row.scope.agentId !== snapshot.agentId : row.scope.roomId !== snapshot.roomId)) ctx.addIssue({ code: 'custom', message: 'Context identity or scope mismatch.' });
};
// v1 retains its exact historical constraints and shape: parsing never upgrades
// or changes the hash/prompt of an already committed snapshot.
const v1 = z.object({ ...base, formatVersion: z.literal(1), memories: z.array(contextMemorySchema.extend({ text: boundedText(256) })).max(32) }).strict().superRefine(checkIdentity);
const v2 = z.object({ ...base, formatVersion: z.literal(2), memories: z.array(contextMemorySchema).max(B.perScope * 2), memoryContexts: z.array(memoryContextSchema).length(2) }).strict().superRefine((snapshot, ctx) => {
  checkIdentity(snapshot, ctx);
  const [personal, room] = snapshot.memoryContexts;
  if (!personal || !room) return;
  if (!sameMemoryScope(personal.scope, { kind: 'agent', agentId: snapshot.agentId }) || !sameMemoryScope(room.scope, { kind: 'room', roomId: snapshot.roomId })) ctx.addIssue({ code: 'custom', message: 'Context scope order mismatch.' });
  let records = 0;
  for (const context of snapshot.memoryContexts) for (const item of context.items) if (item.kind === 'record') {
    records++;
    const ref = item.refs[0], original = ref && snapshot.memories.find(m => sameMemoryScope(m.scope, context.scope) && m.id === ref.id && m.revision === ref.revision);
    if (!original || original.text !== item.text) ctx.addIssue({ code: 'custom', message: 'Loaded record differs from its frozen version.' });
  }
  if (records !== snapshot.memories.length) ctx.addIssue({ code: 'custom', message: 'Unexpected frozen record.' });
});
export const runContextSnapshotSchema = z.discriminatedUnion('formatVersion', [v1, v2]);
export const taskContextQuerySchema = z.object({ type: z.literal('taskContextSnapshot'), roomId: id, taskId: id }).strict();
export const taskContextResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('available'), snapshot: runContextSnapshotSchema }).strict(),
  z.object({ status: z.enum(['not_started', 'not_recorded']), taskId: id, runId: id, snapshot: z.null() }).strict(),
]);
