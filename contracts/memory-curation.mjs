import { z } from 'zod';
import { memoryScopeSchema } from './agent-memory.mjs';

export const CURATION_LIMITS = Object.freeze({ batch: 32, summaries: 16, text: 1024, context: 8192, wireBytes: 65536, startsPerHour: 6, startsPerDay: 24, intervalMs: 600000, executionMs: 120000, provenance: 10000 });
const nonempty = max => z.string().refine(s => s.trim().length > 0 && [...s].length <= max);
const reference = z.string().min(1).max(300);
export const curationScopeSchema = memoryScopeSchema;
export const curationPlanSchema = z.object({
  summaries: z.array(z.object({ inputs: z.array(reference).min(1).max(48), text: nonempty(CURATION_LIMITS.text), reason: nonempty(512) }).strict()).max(CURATION_LIMITS.summaries),
  archives: z.array(z.object({ inputs: z.array(reference).min(1).max(48), reason: nonempty(512) }).strict()).max(48),
}).strict().superRefine((plan, ctx) => {
  if (plan.summaries.reduce((sum, item) => sum + [...item.text].length, 0) > CURATION_LIMITS.context) ctx.addIssue({ code: 'custom', message: 'Summary context budget exceeded.' });
});
export const curatedEntrySchema = z.object({
  id: reference, runId: reference, text: nonempty(CURATION_LIMITS.text), reason: nonempty(512),
  refs: z.array(z.object({ id: reference, revision: z.number().int().positive().safe() }).strict()).min(1).max(CURATION_LIMITS.provenance),
}).strict();
export const curatedHeadSchema = z.array(curatedEntrySchema).max(CURATION_LIMITS.summaries).superRefine((items, ctx) => {
  const refs = items.flatMap(item => item.refs);
  if (refs.length > CURATION_LIMITS.provenance || new Set(refs.map(ref => ref.id)).size !== refs.length || items.reduce((sum, item) => sum + [...item.text].length, 0) > CURATION_LIMITS.context) ctx.addIssue({ code: 'custom', message: 'Invalid or excessive head provenance/context.' });
});

// No fuzzy matching or model-chosen database identifiers: every input is
// accounted for exactly once, including deliberately archived conclusions.
export function validateCurationPlan(value, inputs) {
  const plan = curationPlanSchema.parse(value), remaining = new Set(inputs.map(item => item.key));
  if (remaining.size !== inputs.length) throw Error('Duplicate input identity.');
  for (const item of [...plan.summaries, ...plan.archives]) for (const key of item.inputs) {
    if (!remaining.delete(key)) throw Error('Unknown or duplicated curation reference.');
  }
  if (remaining.size) throw Error('Curation omitted input evidence.');
  return plan;
}
