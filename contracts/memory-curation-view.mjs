import { z } from 'zod';
import { curationScopeSchema, curationPlanSchema, curatedHeadSchema } from './memory-curation.mjs';

const id = z.string().min(1).max(300);
const count = z.number().int().nonnegative().safe();
const state = z.enum(['running', 'applied', 'failed', 'stale', 'unknown']);
const reference = z.object({ id, revision: count.positive() }).strict();
export const curationStatusSchema = z.object({
  configured: z.boolean(), enabled: z.boolean(), revision: count, summaries: curatedHeadSchema,
  pending: count, stale: count, executor: z.object({ agentId: id, model: id }).strict().nullable().optional(),
  latestRun: z.object({ id, status: state, note: z.string(), leaseHeld: z.union([z.literal(0), z.literal(1)]), startedAt: count, finishedAt: count.nullable() }).strict().nullable(),
}).strict();
export const curationHistorySchema = z.object({
  runs: z.array(z.object({
    id, position: count.positive(), status: state, note: z.string(), startedAt: count, finishedAt: count.nullable(),
    input: z.object({
      scope: curationScopeSchema, executor: z.object({ agentId: id, model: id }).strict(),
      inputs: z.array(z.object({ key: id, kind: z.enum(['summary', 'record']), text: z.string(), refs: z.array(reference), updatedAt: z.string().optional() }).strict()).max(48),
      selected: z.array(reference).max(32), prompt: z.string(),
    }).strict(),
    output: curationPlanSchema.nullable(),
  }).strict()).max(100),
  before: count.positive().nullable(),
}).strict();
