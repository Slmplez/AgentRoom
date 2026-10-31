import { z } from 'zod';

export const attachmentLimits = Object.freeze({ fileBytes: 8 * 1024 * 1024, count: 5, totalBytes: 20 * 1024 * 1024, databaseBytes: 256 * 1024 * 1024, pendingMs: 24 * 60 * 60 * 1000 });
export const attachmentExtensions = ['txt', 'md', 'csv', 'json', 'log', 'pdf', 'png', 'jpg', 'jpeg', 'webp'];
const id = z.string().min(1).max(300);
export const attachmentNameSchema = z.string().min(1).max(160).refine(name => name === name.normalize('NFC') && new TextEncoder().encode(name).length <= 240 && !/[<>"|?*\\/:\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\ud800-\udfff\u2066-\u2069]/u.test(name) && !name.includes('..') && !/[. ]$/.test(name) && !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(name) && attachmentExtensions.includes(name.split('.').at(-1).toLowerCase()) && name.includes('.'), '文件名或类型不受支持。');
export const attachmentIdsSchema = z.array(z.string().uuid()).max(attachmentLimits.count).refine(ids => new Set(ids).size === ids.length, '附件不能重复。');
export const attachmentSchema = z.object({ id: z.string().uuid(), roomId: id, uploaderId: id, name: attachmentNameSchema, size: z.number().int().min(1).max(attachmentLimits.fileBytes), sha256: z.string().regex(/^[a-f0-9]{64}$/), mediaType: z.string(), createdAt: z.string(), expiresAt: z.string().nullable(), status: z.enum(['pending', 'linked', 'deleted']), revision: z.number().int().positive() });
const base = { schemaVersion: z.literal(1).default(1), workspaceId: id, roomId: id, key: id };
export const uploadAttachmentSchema = z.object({ ...base, type: z.literal('uploadAttachment'), name: attachmentNameSchema, size: z.number().int().min(1).max(attachmentLimits.fileBytes), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const removeAttachmentSchema = z.object({ ...base, type: z.literal('removeAttachment'), attachmentId: z.string().uuid() }).strict();
export const attachmentCommandTypes = ['uploadAttachment', 'removeAttachment'];
export const attachmentCommandSchema = z.discriminatedUnion('type', [uploadAttachmentSchema, removeAttachmentSchema]);
export const attachmentQuerySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pendingAttachments'), roomId: id, afterId: z.string().uuid().optional(), limit: z.number().int().min(1).max(100).default(100) }).strict(),
  z.object({ type: z.literal('attachment'), roomId: id, attachmentId: z.string().uuid() }).strict(),
]);
export const pendingAttachmentsSchema = z.object({ attachments: z.array(attachmentSchema).max(100), afterId: z.string().uuid().nullable() });
