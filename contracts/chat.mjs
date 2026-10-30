import { z } from 'zod';
import { connectionCommands } from './settings.mjs';
import { managementCommands } from './management.mjs';
import { capabilityCommands } from './capabilities.mjs';
import { collaborationQuestionSchema, questionCommands } from './questions.mjs';

const id = z.string().min(1).max(300);
const question = z.object({ id, title: z.string(), multiple: z.boolean(), options: z.array(z.string()) });
export const runSchema = z.object({ id, agentId: id, roomId: id, messageId: id.nullable(), status: z.enum(['queued', 'running', 'cancel_requested', 'complete', 'cancelled', 'failed', 'unknown']), queuePosition: z.number().int().nonnegative().default(0), canCancel: z.boolean(), error: z.string().default('') });
export const toolSchema = z.object({ id, name: z.string(), status: z.string(), detail: z.string(), output: z.string(), patches: z.array(z.string()).default([]), runId: id.nullable().default(null), detailRef: id.nullable().default(null), hasDiff: z.boolean().default(false), truncated: z.boolean().default(false) });
export const messageSchema = z.object({
  id, roomId: id, sequence: z.number(), authorId: id, authorName: z.string(), role: z.enum(['user', 'assistant']),
  text: z.string(), status: z.enum(['running', 'complete', 'failed', 'cancelled', 'unknown']),
  createdAt: z.string(), tools: z.array(toolSchema).default([]),
  replyToId: z.string().nullable().default(null), recipientIds: z.array(id).default([]), runId: id.nullable().default(null),
});
export const approvalSchema = z.object({
  id, agentId: id, roomId: z.string(), revision: z.number().int().nonnegative(),
  kind: z.enum(['permission', 'questions', 'input']), title: z.string(), summary: z.string(),
  status: z.enum(['pending', 'submitting', 'allowed', 'denied', 'expired', 'unknown']).default('pending'),
  runId: id.nullable().default(null), allowedDecisions: z.array(z.enum(['allow', 'deny'])).default(['allow', 'deny']),
  delivery: z.enum(['pending', 'submitted', 'confirmed', 'unknown']).default('pending'),
  decision: z.enum(['allow', 'deny']).nullable().default(null),
  scopeLabel: z.string(), directory: z.string(), questions: z.array(question).default([]), options: z.array(z.string()).default([]),
});
export const snapshotSchema = z.object({
  instanceId: id, revision: z.number().int().nonnegative(),
  agents: z.array(z.object({ id, name: z.string(), displayName: z.string(), engine: z.string(), engineId: z.string().default(''), tag: z.string().default(''), directory: z.string().default(''), status: z.string(), workspaceId: id })),
  rooms: z.array(z.object({ id, title: z.string(), type: z.enum(['group', 'dm']), workspaceId: id, memberIds: z.array(id), ownerAgentId: z.string().nullable().default(null), pinned: z.boolean().default(false), description: z.string().default('') })),
  workspaces: z.array(z.object({ id, title: z.string(), directory: z.string() })),
  messages: z.array(messageSchema), approvals: z.array(approvalSchema), runs: z.array(runSchema).default([]), approvalHistory: z.array(approvalSchema).default([]),
  currentUserId: id.nullable().default(null), questions: z.array(collaborationQuestionSchema).default([]),
  capabilities: z.object({ tasks: z.boolean(), idempotentSend: z.boolean().default(false), collaborationQuestions: z.boolean().default(false) }),
});
export const commandSchema = z.discriminatedUnion('type', [
  ...connectionCommands,
  ...managementCommands,
  ...capabilityCommands,
  ...questionCommands,
  z.object({ type: z.literal('cancelRun'), key: id, runId: id }),
  z.object({ type: z.literal('send'), key: id, roomId: id, text: z.string().min(1).max(16000), mode: z.enum(['discussion', 'task']), ownerAgentId: z.string().nullable(),
    mentions: z.array(z.object({ agentId: id, start: z.number().int().nonnegative(), end: z.number().int().positive() })) }),
  z.object({ type: z.literal('decide'), approvalId: id, expectedRevision: z.number().int().nonnegative(), allow: z.boolean(), answers: z.array(z.array(z.string().max(4000))).default([]), value: z.string().max(16000).default('') }),
]);
export function clientError(code, message, outcome = 'rejected') { return Object.assign(new Error(message), { code, outcome, requestId: globalThis.crypto.randomUUID() }); }
export const receiptSchema = z.object({ accepted: z.literal(true), operationId: id, entityId: id.optional(), delivery: z.enum(['submitted', 'confirmed']).optional() });
export const errorSchema = z.object({ code: id, message: z.string(), outcome: z.enum(['rejected', 'unknown']), requestId: id });
