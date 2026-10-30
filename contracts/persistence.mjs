import { z } from 'zod';
import { messageSchema } from './chat.mjs';
import { localTaskSchema } from './local-execution.mjs';

export const SCHEMA_VERSION = 1;
const id = z.string().min(1).max(300);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cursor = z.string().min(1).max(1000);
export const persistenceRoomSchema = z.object({ id, workspaceId: id, title: z.string(), revision: counter.positive() });
const commandBase = { schemaVersion: z.literal(1).default(1), workspaceId: id, key: id };
export const persistenceCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...commandBase, type: z.literal('createRoom'), title: z.string().min(1).max(200) }).strict(),
  z.object({ ...commandBase, type: z.literal('sendDiscussion'), roomId: id, text: z.string().min(1).max(16000), replyToId: id.nullable().default(null), mentions: z.array(z.never()).max(0).default([]) }).strict(),
]);
export const persistenceMessageSchema = messageSchema.extend({ sequence: counter.positive(), authorKind: z.literal('human'), revision: counter.positive() });
export const persistenceEventSchema = z.object({
  schemaVersion: z.literal(1), eventId: id, type: z.enum(['room.created', 'message.created', 'localTask.updated']),
  entityId: id, entityRevision: counter.positive(), operationId: id, workspaceId: id, roomId: id,
  occurredAt: z.string(), cursor, payload: z.union([persistenceMessageSchema, persistenceRoomSchema, localTaskSchema]),
}).superRefine((event, ctx) => {
  const schema = event.type === 'localTask.updated' ? localTaskSchema : event.type === 'message.created' ? persistenceMessageSchema : persistenceRoomSchema;
  if (!schema.safeParse(event.payload).success || event.payload.id !== event.entityId || event.payload.revision !== event.entityRevision ||
      (event.type !== 'room.created' ? event.payload.roomId !== event.roomId : event.payload.id !== event.roomId || event.payload.workspaceId !== event.workspaceId)) {
    ctx.addIssue({ code: 'custom', message: 'Event identity or payload mismatch.' });
  }
});
export const persistenceFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('event'), data: persistenceEventSchema }),
  z.object({ type: z.literal('checkpoint'), cursor }),
]);
export const persistenceBootstrapSchema = z.object({
  schemaVersion: z.literal(1), databaseId: id, instanceId: id,
  user: z.object({ id, name: z.string() }), workspace: z.object({ id, title: z.string() }),
  capabilities: z.object({ persistentMessages: z.literal(true), eventStream: z.literal(true), idempotentSend: z.literal(true), tasks: z.literal(false) }),
});
export const persistenceSnapshotSchema = z.object({
  schemaVersion: z.literal(1), databaseId: id, instanceId: id, cursor,
  room: persistenceRoomSchema, messages: z.array(persistenceMessageSchema),
  roomSequenceUpperBound: counter, beforeSequence: counter.positive().nullable(),
});
export const persistenceHistorySchema = z.object({
  schemaVersion: z.literal(1), databaseId: id, roomId: id,
  messages: z.array(persistenceMessageSchema).max(200),
  roomSequenceUpperBound: counter, beforeSequence: counter.positive().nullable(), cursor,
});
export const persistenceReceiptSchema = z.object({
  schemaVersion: z.literal(1), accepted: z.literal(true), operationId: id,
  roomId: id, messageId: id.nullable(), sequence: counter.nullable(), cursor: id,
  taskId: id.optional(),
});
export const persistenceQuerySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bootstrap') }).strict(),
  z.object({ type: z.literal('rooms'), workspaceId: id }).strict(),
  z.object({ type: z.literal('snapshot'), roomId: id }).strict(),
  z.object({ type: z.literal('messages'), roomId: id, limit: counter.min(1).max(200).default(100), beforeSequence: counter.positive().optional(), upperBound: counter.optional() }).strict(),
  z.object({ type: z.literal('events'), roomId: id, after: z.string().max(1000).optional(), limit: counter.min(1).max(200).default(100) }).strict(),
  z.object({ type: z.literal('operation'), operationId: id }).strict(),
  z.object({ type: z.literal('receipt'), workspaceId: id, commandType: z.enum(['createRoom', 'sendDiscussion', 'createLocalTask', 'answerLocalQuestion']), key: id }).strict(),
]);
export function persistenceError(code, message, status = 400, outcome = 'rejected') {
  return Object.assign(new Error(message), { code, status, outcome });
}
