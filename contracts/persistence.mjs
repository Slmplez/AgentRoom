import { z } from 'zod';
import { messageSchema } from './chat.mjs';

export const SCHEMA_VERSION = 1;
const id = z.string().min(1).max(300);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const commandBase = { schemaVersion: z.literal(1).default(1), workspaceId: id, key: id };
export const persistenceCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...commandBase, type: z.literal('createRoom'), title: z.string().min(1).max(200) }).strict(),
  z.object({ ...commandBase, type: z.literal('sendDiscussion'), roomId: id, text: z.string().min(1).max(16000), replyToId: id.nullable().default(null), mentions: z.array(z.never()).max(0).default([]) }).strict(),
]);
export const persistenceMessageSchema = messageSchema.extend({ sequence: counter.positive(), authorKind: z.literal('human'), revision: counter.positive() });
export const persistenceReceiptSchema = z.object({
  schemaVersion: z.literal(1), accepted: z.literal(true), operationId: id,
  roomId: id, messageId: id.nullable(), sequence: counter.nullable(), cursor: id,
});
export const persistenceQuerySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('bootstrap') }).strict(),
  z.object({ type: z.literal('rooms'), workspaceId: id }).strict(),
  z.object({ type: z.literal('messages'), roomId: id, limit: counter.min(1).max(200).default(100), beforeSequence: counter.positive().optional(), upperBound: counter.optional() }).strict(),
  z.object({ type: z.literal('events'), roomId: id, after: z.string().max(1000).optional(), limit: counter.min(1).max(200).default(100) }).strict(),
  z.object({ type: z.literal('operation'), operationId: id }).strict(),
  z.object({ type: z.literal('receipt'), workspaceId: id, commandType: z.enum(['createRoom', 'sendDiscussion']), key: id }).strict(),
]);
export function persistenceError(code, message, status = 400, outcome = 'rejected') {
  return Object.assign(new Error(message), { code, status, outcome });
}
