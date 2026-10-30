import { z } from 'zod';
const count = z.number().nonnegative();
export const contextSchema = z.object({ used: count.nullable().default(null), window: count.nullable().default(null), source: z.string().default('unknown'), windowSource: z.string().default('unknown'), reason: z.string().default(''), updatedAt: z.string().nullable().default(null), model: z.string().nullable().optional(), confidence: z.enum(['observed', 'estimated', 'unknown']).default('unknown') });
const totals = z.object({ requests: count, known: count, unknown: count, errors: count, input: count, output: count, cached: count, cacheWrite: count, total: count });
export const telemetryQueries = [z.object({ type: z.literal('usage') }), z.object({ type: z.literal('contexts') })];
export const telemetryQueryResults = {
  usage: z.object({ totals, days: z.array(z.object({ date: z.string(), requests: count, unknown: count, total: count })), engines: z.array(totals.extend({ label: z.string() })), models: z.array(totals.extend({ label: z.string() })), period: z.object({ from: z.string(), to: z.string() }), timezone: z.string(), error: z.string().default(''), simulated: z.boolean().default(false) }),
  contexts: z.object({ agents: z.array(z.object({ agentId: z.string(), context: contextSchema })), simulated: z.boolean().default(false) }),
};
