import { curationCommandTypes, curationCommandSchema } from './memory-curation-api.mjs';
import { formStateSchema, formCommandTypes } from './forms.mjs';
import { attachmentSchema, attachmentIdsSchema, attachmentCommandTypes } from './attachments.mjs';
import { z } from 'zod';
import { messageSchema } from './chat.mjs';
import { localTaskSchema } from './local-execution.mjs';
import { memoryCommandTypes } from './agent-memory.mjs';
import { consultationSchema, consultationAgentSchema, consultationCommandTypes } from './consultations.mjs';

export const SCHEMA_VERSION = 1;
const id = z.string().min(1).max(300);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cursor = z.string().min(1).max(1000);
export const persistenceRoomSchema = z.object({ id, workspaceId: id, title: z.string(), revision: counter.positive() });
const commandBase = { schemaVersion: z.literal(1).default(1), workspaceId: id, key: id };
export const persistenceCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...commandBase, type: z.literal('createRoom'), title: z.string().min(1).max(200) }).strict(),
  z.object({ ...commandBase, type: z.literal('sendDiscussion'), roomId: id, text: z.string().max(16000), attachmentIds: attachmentIdsSchema.default([]), replyToId: id.nullable().default(null), mentions: z.array(z.never()).max(0).default([]) }).strict(),
]);
export const persistenceMessageSchema = messageSchema.extend({ sequence: counter.positive(), authorKind: z.enum(['human','agent']), revision: counter.positive() });
export const persistenceEventSchema = z.object({
  schemaVersion: z.literal(1), eventId: id, type: z.enum(['room.created', 'message.created', 'localTask.updated', 'consultation.updated', 'attachment.updated', 'form.updated']),
  entityId: id, entityRevision: counter.positive(), operationId: id, workspaceId: id, roomId: id,
  occurredAt: z.string(), cursor, payload: z.union([persistenceMessageSchema, persistenceRoomSchema, localTaskSchema, consultationSchema, attachmentSchema, formStateSchema]),
}).superRefine((event, ctx) => {
  const schema = event.type === 'form.updated' ? formStateSchema : event.type === 'attachment.updated' ? attachmentSchema : event.type === 'consultation.updated' ? consultationSchema : event.type === 'localTask.updated' ? localTaskSchema : event.type === 'message.created' ? persistenceMessageSchema : persistenceRoomSchema;
  if (!schema.safeParse(event.payload).success || (event.type==='form.updated'?event.payload.artifactId:event.payload.id) !== event.entityId || (event.type==='form.updated'?event.payload.waitRevision:event.payload.revision) !== event.entityRevision ||
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
  capabilities: z.object({ fileReview: z.boolean().default(false), forms: z.boolean().default(false), attachments: z.boolean().default(false), persistentMessages: z.literal(true), eventStream: z.literal(true), idempotentSend: z.literal(true), tasks: z.literal(false), consultations: z.boolean().default(false), memoryCuration: z.boolean().default(false), agentMemory: z.boolean().default(false), readOnlyArtifacts: z.boolean().default(false), artifactPublishing: z.boolean().default(false), localExecution: z.boolean().default(false) }), localAgentId: id.optional(), knownAgents: z.array(id).default([]), consultationAgents: z.array(consultationAgentSchema).default([]),
});
export const persistenceSnapshotSchema = z.object({
  schemaVersion: z.literal(1), databaseId: id, instanceId: id, cursor,
  room: persistenceRoomSchema, messages: z.array(persistenceMessageSchema),
  localTasks: z.array(localTaskSchema).default([]),
  consultations: z.array(consultationSchema).default([]),
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
  form: formStateSchema.optional(),
  attachment: attachmentSchema.optional(),
  taskId: id.optional(),
  consultationId: id.optional(),
  artifactId: id.optional(), artifactVersion: counter.positive().optional(),
});
export const persistenceQuerySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bootstrap') }).strict(),
  z.object({ type: z.literal('rooms'), workspaceId: id }).strict(),
  z.object({ type: z.literal('snapshot'), roomId: id }).strict(),
  z.object({ type: z.literal('messages'), roomId: id, limit: counter.min(1).max(200).default(100), beforeSequence: counter.positive().optional(), upperBound: counter.optional() }).strict(),
  z.object({ type: z.literal('events'), roomId: id, after: z.string().max(1000).optional(), limit: counter.min(1).max(200).default(100) }).strict(),
  z.object({ type: z.literal('operation'), operationId: id }).strict(),
  z.object({ type: z.literal('receipt'), workspaceId: id, commandType: z.enum(['createRoom', 'sendDiscussion', 'createLocalTask', 'answerLocalQuestion', 'publishArtifact', 'publishForm', ...formCommandTypes, ...attachmentCommandTypes, ...memoryCommandTypes, ...curationCommandTypes, ...consultationCommandTypes]), key: z.string().min(1).max(650) }).strict(),
]);
export function persistenceError(code, message, status = 400, outcome = 'rejected') {
  return Object.assign(new Error(message), { code, status, outcome });
}
