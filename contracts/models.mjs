import { z } from 'zod';
export const modelDescriptorSchema = z.object({
  id: z.string().min(1).max(200), name: z.string().max(200), source: z.enum(['upstream', 'manual']),
  capabilities: z.object({ tools: z.boolean().nullable(), images: z.boolean().nullable(), streaming: z.boolean().nullable(), reasoning: z.boolean().nullable(), contextWindow: z.number().int().positive().nullable(), maxOutputTokens: z.number().int().positive().nullable() }),
  compatibility: z.array(z.object({ engineId: z.string(), status: z.enum(['compatible', 'incompatible', 'unknown']), reason: z.string() })),
});
export const modelDiscoverySchema = z.object({
  ok: z.boolean(), message: z.string(), models: z.array(z.string()).default([]),
  catalog: z.array(modelDescriptorSchema).default([]), latencyMs: z.number().nullable().optional(),
});
