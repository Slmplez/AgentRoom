import { z } from 'zod';
const id = z.string().min(1).max(300);
export const reviewHash = z.string().regex(/^[a-f0-9]{64}$/);
export const reviewPath = z.string().min(1).max(500).refine(value => !value.includes('\\') && !value.startsWith('/') && value.split('/').every(p => p && p !== '.' && p !== '..' && !/[<>:"|?*\x00-\x1f]/.test(p) && !/[. ]$/.test(p) && !/^(\.git|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)), '需要工作区内的相对文件路径');
const scope = { workspaceId: id, roomId: id, file: reviewPath };
export const reviewRequestSchema = z.discriminatedUnion('type', [
 z.object({ type: z.literal('changes'), workspaceId:id, roomId:id }).strict(),
 z.object({ type: z.literal('readFile'), ...scope }).strict(),
 z.object({ type: z.literal('saveFile'), ...scope, key: id, rootId: reviewHash, expectedRevision: reviewHash, text: z.string().max(262144) }).strict(),
 z.object({ type: z.literal('comments'), ...scope, version: reviewHash }).strict(),
 z.object({ type: z.literal('addComment'), ...scope, key: id, version: reviewHash, side: z.enum(['additions','deletions']), line: z.number().int().min(1).max(1000000), quote: z.string().max(1000), text: z.string().trim().min(1).max(4000) }).strict(),
]);
export const reviewCommentSchema = z.object({ id, authorId:id, authorName:z.string(), version:reviewHash, side:z.enum(['additions','deletions']), line:z.number().int().positive(), quote:z.string(), text:z.string(), createdAt:z.string() });
export const reviewResultSchema = z.discriminatedUnion('type',[
 z.object({type:z.literal('changes'),workspaceId:id,roomId:id,rootId:reviewHash,base:z.string(),complete:z.literal(true),files:z.array(z.object({file:z.string(),status:z.string(),patch:z.string().nullable(),editable:z.boolean(),reason:z.string().optional()})).max(60),simulated:z.boolean().default(false)}),
 z.object({type:z.literal('file'),...scope,rootId:reviewHash,revision:reviewHash,text:z.string(),simulated:z.boolean().default(false)}),
 z.object({type:z.literal('saved'),...scope,rootId:reviewHash,revision:reviewHash,key:id,simulated:z.boolean().default(false)}),
 z.object({type:z.literal('comments'),...scope,version:reviewHash,comments:z.array(reviewCommentSchema),simulated:z.boolean().default(false)}),
 z.object({type:z.literal('comment'),...scope,key:id,comment:reviewCommentSchema,simulated:z.boolean().default(false)}),
]);
export const reviewFailure = (code,message,outcome='rejected') => Object.assign(new Error(message),{code,outcome});
export function validateReviewResponse(input,raw,{authorId,real=false}={}) {
 const parsed=reviewResultSchema.safeParse(raw),outcome=['saveFile','addComment'].includes(input.type)?'unknown':'rejected';
 const bad=()=>{throw reviewFailure('invalid_response','文件审阅响应范围或内容不匹配。',outcome);};
 if(!parsed.success)bad();const result=parsed.data;
 const expected={changes:'changes',readFile:'file',saveFile:'saved',comments:'comments',addComment:'comment'}[input.type];
 if(result.type!==expected||result.workspaceId!==input.workspaceId||result.roomId!==input.roomId||('file'in input&&result.file!==input.file)||('key'in input&&result.key!==input.key)||(real&&result.simulated))bad();
 if(result.type==='saved'&&result.rootId!==input.rootId)bad();
 if(result.type==='comments'&&(result.version!==input.version||result.comments.some(c=>c.version!==input.version||authorId&&c.authorId!==authorId)))bad();
 if(result.type==='comment'&&(['version','side','line','quote','text'].some(key=>result.comment[key]!==input[key])||authorId&&result.comment.authorId!==authorId))bad();
 if(result.type==='changes'&&(new Set(result.files.map(f=>f.file)).size!==result.files.length||result.files.some(f=>f.editable&&!reviewPath.safeParse(f.file).success)))bad();
 return result;
}
