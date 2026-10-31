import { z } from 'zod';
import { memoryScopeSchema } from './agent-memory.mjs';
import { curationStatusSchema, curationHistorySchema } from './memory-curation-view.mjs';

const id = z.string().min(1).max(300);
const revision = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1);
const base = { schemaVersion: z.literal(1).default(1), workspaceId: id, scope: memoryScopeSchema, key: id };
export const curationCommandTypes = ['configureMemoryCuration', 'inspectMemoryCuration'];
export const curationCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('configureMemoryCuration'), enabled: z.boolean(), expectedRevision: revision }).strict(),
  z.object({ ...base, type: z.literal('inspectMemoryCuration'), runId: id }).strict(),
]);
export const curationQueryTypes = ['memoryCurationStatus', 'memoryCurationHistory'];
export const curationQuerySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('memoryCurationStatus'), workspaceId: id, scope: memoryScopeSchema }).strict(),
  z.object({ type: z.literal('memoryCurationHistory'), workspaceId: id, scope: memoryScopeSchema, before: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(), limit: z.number().int().min(1).max(100).default(20) }).strict(),
]);
export const curationQueryResults = { memoryCurationStatus: curationStatusSchema, memoryCurationHistory: curationHistorySchema };
const receipt = { schemaVersion: z.literal(1), accepted: z.literal(true), operationId: id, scope: memoryScopeSchema };
export const curationReceiptSchema = z.discriminatedUnion('type', [
  z.object({ ...receipt, type: z.literal('configureMemoryCuration'), revision: revision.positive(), enabled: z.boolean() }).strict(),
  z.object({ ...receipt, type: z.literal('inspectMemoryCuration'), runId: id }).strict(),
]);
