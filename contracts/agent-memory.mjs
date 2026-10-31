import { z } from 'zod';

// Storage has no per-scope count ceiling. Task context has a separate budget.
export const MEMORY_LIMITS = Object.freeze({ perScope: null, text: 2048, soul: 2048 });
export const MEMORY_CONTEXT_LIMITS = Object.freeze({ perScope: 16, characters: 8192 });
const id = z.string().min(1).max(300);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().refine(value => value.trim().length > 0 && [...value].length <= MEMORY_LIMITS.text, '记忆须为 1–2048 个 Unicode 字符。');
export const memoryScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('agent'), agentId: id }).strict(),
  z.object({ kind: z.literal('room'), roomId: id }).strict(),
]);
const base = { workspaceId: id, key: id };
const soulFields = { personality: z.string(), expression: z.string(), workStyle: z.string() };
export const soulContentSchema = z.object(soulFields).strict().refine(value =>
  Object.values(value).reduce((n, s) => n + [...s].length, 0) <= MEMORY_LIMITS.soul, 'Soul 最多 2048 个 Unicode 字符。');
export const memoryCommandTypes = ['editAgentSoul', 'saveExplicitMemory', 'correctExplicitMemory', 'forgetExplicitMemory'];
export const memoryCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('editAgentSoul'), agentId: id, expectedRevision: revision, ...soulFields }).strict().refine(value =>
    soulContentSchema.safeParse({ personality: value.personality, expression: value.expression, workStyle: value.workStyle }).success, 'Soul 超出长度限制。'),
  z.object({ ...base, type: z.literal('saveExplicitMemory'), scope: memoryScopeSchema, text, source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('owner-note') }).strict(),
    z.object({ kind: z.literal('message'), messageId: id, revision: revision.positive() }).strict(),
  ]) }).strict(),
  z.object({ ...base, type: z.literal('correctExplicitMemory'), scope: memoryScopeSchema, memoryId: id, expectedRevision: revision.positive(), text }).strict(),
  z.object({ ...base, type: z.literal('forgetExplicitMemory'), scope: memoryScopeSchema, memoryId: id, expectedRevision: revision.positive() }).strict(),
]);
const page = { limit: z.number().int().min(1).max(100).default(20), beforeRevision: revision.positive().optional() };
export const memoryQueryTypes = ['agentSoul', 'agentSoulHistory', 'explicitMemories', 'explicitMemoryHistory'];
export const memoryQuerySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('agentSoul'), workspaceId: id, agentId: id }).strict(),
  z.object({ type: z.literal('agentSoulHistory'), workspaceId: id, agentId: id, ...page }).strict(),
  z.object({ type: z.literal('explicitMemories'), workspaceId: id, scope: memoryScopeSchema, limit: z.number().int().min(1).max(100).default(20), afterId: id.optional() }).strict(),
  z.object({ type: z.literal('explicitMemoryHistory'), workspaceId: id, scope: memoryScopeSchema, memoryId: id, ...page }).strict(),
]);
export const memoryReceiptSchema = z.object({
  schemaVersion: z.literal(1), accepted: z.literal(true), operationId: id,
  entityKind: z.enum(['soul', 'memory']), entityId: id, scope: memoryScopeSchema,
  revision: revision.positive(), status: z.enum(['active', 'deleted']),
}).strict();

const soulView = z.object({ agentId: id, configured: z.boolean(), revision, ...soulFields, authorId: id.nullable(), updatedAt: z.string().nullable() }).strict();
const memoryVersion = { revision: revision.positive(), status: z.enum(['active', 'deleted']), text, sourceIds: z.array(id).min(1), authorId: id };
const memoryView = z.object({ id, scope: memoryScopeSchema, ...memoryVersion, updatedAt: z.string() }).strict();
export const memoryQueryResults = {
  agentSoul: soulView,
  agentSoulHistory: z.object({ agentId: id, revisions: z.array(z.object({ revision: revision.positive(), ...soulFields, authorId: id, createdAt: z.string() }).strict()), beforeRevision: revision.positive().nullable() }).strict(),
  explicitMemories: z.object({ scope: memoryScopeSchema, memories: z.array(memoryView).max(100), total: revision, afterId: id.nullable(), limits: z.object({ perScope: z.null(), text: z.literal(2048), soul: z.literal(2048) }).strict() }).strict(),
  explicitMemoryHistory: z.object({ current: memoryView, revisions: z.array(z.object({ ...memoryVersion, createdAt: z.string() }).strict()), sources: z.array(z.object({ id, kind: z.enum(['owner-note', 'message']), text: z.string(), authorId: id, occurredAt: z.string(), recordedAt: z.string(), roomId: id.nullable(), messageId: id.nullable(), messageRevision: revision.positive().nullable() }).strict()), beforeRevision: revision.positive().nullable() }).strict(),
};
export const scopeForMemory = command => command.type === 'editAgentSoul' ? { kind: 'agent', agentId: command.agentId } : command.scope;
export const sameMemoryScope = (a, b) => a?.kind === b?.kind && (a?.kind === 'agent' ? a.agentId === b.agentId : a?.kind === 'room' && a.roomId === b.roomId);
