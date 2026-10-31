import { z } from 'zod';
const id = z.string().min(1).max(300);
const revision = z.number().int().nonnegative();
const base = { workspaceId: id, roomId: id, key: id };
const existing = { ...base, consultationId: id, expectedRevision: revision.positive() };
export const consultationAgentSchema = z.object({ id, displayName: z.string().min(1).max(100), engine: z.literal('pi'), model: z.string().min(1).max(200) });
export const consultationSourceSchema = z.object({ taskId: id, questionId: id, questionRevision: revision }).strict();
export const consultationCommandSchema = z.discriminatedUnion('type', [
  z.object({ ...base, type: z.literal('createConsultation'), title: z.string().trim().min(1).max(500), instruction: z.string().max(4000).default(''), agentIds: z.array(id).min(1).max(3), source: consultationSourceSchema.nullable().default(null) }).strict(),
  z.object({ ...existing, type: z.literal('decideConsultation'), text: z.string().max(4000).default(''), adoptedAssignmentId: id.nullable().default(null) }).strict(),
  z.object({ ...existing, type: z.literal('cancelConsultation') }).strict(),
  z.object({ ...existing, type: z.literal('resumeConsultation'), assignmentId: id }).strict(),
  z.object({ ...existing, type: z.literal('checkConsultation'), assignmentId: id }).strict(),
  z.object({ ...existing, type: z.literal('abandonConsultation'), assignmentId: id }).strict(),
]);
export const consultationCommandTypes = ['createConsultation', 'decideConsultation', 'cancelConsultation', 'resumeConsultation', 'checkConsultation', 'abandonConsultation'];
export const consultationQuerySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('consultations'), roomId: id }).strict(),
  z.object({ type: z.literal('consultation'), roomId: id, consultationId: id }).strict(),
  z.object({ type: z.literal('consultationContext'), roomId: id, consultationId: id, assignmentId: id }).strict(),
]);
export const consultationAssignmentSchema = z.object({
  id, agentId: id, runId: id, status: z.enum(['queued','paused','dispatching','running','answered','failed','cancelling','cancelled','unknown','abandoned']),
  text: z.string().max(4000), note: z.string(), startedAt: z.string().nullable(), finishedAt: z.string().nullable(),
  leaseHeld: z.boolean(), stopConfirmed: z.boolean(), contextSnapshotId: id.nullable(),
});
export const consultationSchema = z.object({
  id, roomId: id, authorId: id, revision: revision.positive(), title: z.string(), instruction: z.string(), createdAt: z.string(), expiresAt: z.string(),
  status: z.enum(['pending','resolved','cancelled','expired']), source: consultationSourceSchema.extend({ runId: id, ownerAgentId: id }).nullable(),
  response: z.object({ authorId: id, text: z.string(), adoptedAssignmentId: id.nullable(), delivery: z.enum(['none','recorded','unavailable']) }).nullable(),
  assignments: z.array(consultationAssignmentSchema).max(3), startsUsed: revision.max(3),
});
export const CONSULTATION_LIMITS = Object.freeze({ concurrency: 2, perAgent: 1, queued: 20, executionMs: 120000, questionMs: 600000, starts: 3, depth: 1 });
