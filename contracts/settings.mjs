import { z } from 'zod';
import { consultationQuerySchema, consultationSchema } from './consultations.mjs';
import { runContextSnapshotSchema } from './run-context.mjs';
import { catalogSchema } from './management.mjs';
import { capabilityQueries, capabilityQueryResults } from './capabilities.mjs';
import { telemetryQueries, telemetryQueryResults } from './telemetry.mjs';
import { questionQueries, questionQueryResults } from './questions.mjs';
import { modelDiscoverySchema } from './models.mjs';
import { artifactQuerySchema, artifactVersionSchema, artifactVersionsSchema } from './artifacts.mjs';
import { memoryQuerySchema, memoryQueryResults } from './agent-memory.mjs';
import { taskContextQuerySchema, taskContextResultSchema } from './run-context.mjs';

const id = z.string().min(1).max(300);
const text = z.string().max(2048);
export const connectionProfileSchema = z.object({
  name: z.string().trim().min(1).max(60), protocol: z.enum(['multi', 'responses', 'chat', 'anthropic']),
  baseUrl: text, model: z.string().min(1).max(200), authMode: z.enum(['bearer', 'api-key', 'none']),
  caPath: text.default(''), clientCertPath: text.default(''), clientKeyPath: text.default(''),
  contextWindow: z.number().int().min(1024).max(10000000), maxTokens: z.number().int().positive(), reasoning: z.boolean().default(false),
});
export const connectionSummarySchema = connectionProfileSchema.extend({ id, hasApiKey: z.boolean(), hasPassphrase: z.boolean(), compatibleEngines: z.array(z.string()) });
const credential = z.discriminatedUnion('action', [z.object({ action: z.literal('keep') }), z.object({ action: z.literal('clear') }), z.object({ action: z.literal('replace'), value: z.string().min(1).max(4096) })]);
const connectionWrite = z.object({ id: id.optional(), profile: connectionProfileSchema, credentials: z.object({ apiKey: credential, passphrase: credential }) });
export const connectionCommands = [
  connectionWrite.extend({ type: z.literal('saveConnection'), key: id }),
  z.object({ type: z.literal('removeConnection'), key: id, id }),
];
export const querySchema = z.discriminatedUnion('type', [
  ...consultationQuerySchema.options,
  ...memoryQuerySchema.options, taskContextQuerySchema,
  ...artifactQuerySchema.options,
  z.object({ type: z.literal('toolDetails'), ref: id }),
  ...questionQueries,
  ...capabilityQueries, ...telemetryQueries,
  z.object({ type: z.literal('catalog'), refresh: z.boolean().default(false) }),
  z.object({ type: z.literal('connections') }),
  connectionWrite.extend({ type: z.literal('testConnection'), profile: connectionProfileSchema.extend({ model: z.string().max(200).default('') }) }),
  z.object({ type: z.literal('modelCatalog'), connectionId: id, model: z.string().max(200).optional() }),
]);
export const queryResults = {
  consultation: consultationSchema, consultations: z.array(consultationSchema), consultationContext: runContextSnapshotSchema,
  ...memoryQueryResults, taskContextSnapshot: taskContextResultSchema,
  artifact: artifactVersionSchema, artifactVersions: artifactVersionsSchema,
  ...questionQueryResults,
  toolDetails: z.object({ id, runId: id.nullable(), output: z.string().max(16000), patches: z.array(z.string()), truncated: z.boolean() }),
  ...capabilityQueryResults, ...telemetryQueryResults,
  catalog: catalogSchema,
  connections: z.object({ profiles: z.array(connectionSummarySchema), secureStorageAvailable: z.boolean(), simulated: z.boolean().default(false) }),
  testConnection: modelDiscoverySchema,
  modelCatalog: modelDiscoverySchema,
};
