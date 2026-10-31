import { z } from 'zod';
import { attachmentIdsSchema, attachmentSchema } from './attachments.mjs';
const id=z.string().min(1).max(300), revision=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1);
const fieldId=z.string().min(1).max(64).regex(/^[A-Za-z][A-Za-z0-9_]*$/).refine(value=>!['__proto__','constructor','prototype'].includes(value));
const valueSchema=z.union([z.string().max(4000),z.number().finite().min(-1e12).max(1e12),z.boolean(),z.array(z.string().max(300)).max(30)]);
export const formValuesSchema=z.record(fieldId,valueSchema).refine(value=>new TextEncoder().encode(JSON.stringify(value)).length<=64*1024,'答复最多 64 KiB。');
const base={id:fieldId,label:z.string().min(1).max(200),description:z.string().max(2000).default(''),required:z.boolean().default(false),default:valueSchema.optional()};
const option=z.object({id:fieldId,label:z.string().min(1).max(200)}).strict();
const options=z.array(option).min(1).max(30).refine(list=>new Set(list.map(o=>o.id)).size===list.length,'选项 ID 不能重复。');
const numeric=z.number().finite().min(-1e12).max(1e12);
export function validFormDate(value) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year,month,day]=value.split('-').map(Number), leap=year%4===0 && (year%100!==0 || year%400===0);
  return year>=1 && month>=1 && month<=12 && day>=1 && day<=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31][month-1];
}
const date=z.string().refine(validFormDate,'日期必须是有效的 YYYY-MM-DD。');
export const formFieldSchema=z.discriminatedUnion('type',[
  z.object({...base,type:z.literal('text'),maxLength:z.number().int().min(1).max(500).default(500)}).strict(),
  z.object({...base,type:z.literal('textarea'),maxLength:z.number().int().min(1).max(4000).default(4000)}).strict(),
  z.object({...base,type:z.literal('number'),min:numeric.optional(),max:numeric.optional(),integer:z.boolean().default(false)}).strict(),
  z.object({...base,type:z.literal('select'),options}).strict(),
  z.object({...base,type:z.literal('multiselect'),options,maxSelections:z.number().int().min(1).max(30).default(30)}).strict(),
  z.object({...base,type:z.literal('checkbox')}).strict(),
  z.object({...base,type:z.literal('date'),min:date.optional(),max:date.optional()}).strict(),
  z.object({...base,type:z.literal('attachments')}).strict(),
]);
export function formValueError(field,value,{initial=false}={}) {
  if(value===undefined) return field.required && !initial ? '此项必填。' : '';
  if(field.type==='text'||field.type==='textarea') return typeof value!=='string' || value.length>field.maxLength || field.required&&!value.trim() || field.type==='text'&&/[\r\n]/.test(value) ? '请输入长度范围内的有效文本。' : '';
  if(field.type==='number') return typeof value!=='number'||!Number.isFinite(value)||Math.abs(value)>1e12||field.integer&&!Number.isInteger(value)||field.min!==undefined&&value<field.min||field.max!==undefined&&value>field.max ? '请输入范围内的有效数字。' : '';
  if(field.type==='checkbox') return typeof value!=='boolean'||field.required&&!value ? '请勾选此项。' : '';
  if(field.type==='date') return typeof value!=='string'||!validFormDate(value)||field.min!==undefined&&value<field.min||field.max!==undefined&&value>field.max ? '请选择范围内的有效日期。' : '';
  if(field.type==='select') return typeof value!=='string'||!field.options.some(o=>o.id===value) ? '请选择有效选项。' : '';
  if(field.type==='multiselect') return !Array.isArray(value)||new Set(value).size!==value.length||value.length>field.maxSelections||field.required&&!value.length||value.some(v=>!field.options.some(o=>o.id===v)) ? '请选择有效且不重复的选项。' : '';
  return !attachmentIdsSchema.safeParse(value).success||field.required&&!value.length ? '请选择有效附件。' : '';
}
export const formSchema=z.object({groups:z.array(z.object({id:fieldId,title:z.string().max(200),description:z.string().max(2000).default(''),fields:z.array(formFieldSchema).min(1).max(20)}).strict()).min(1).max(6)}).strict().superRefine((spec,ctx)=>{
  const fields=spec.groups.flatMap(g=>g.fields),ids=fields.map(f=>f.id);
  const issue=message=>ctx.addIssue({code:'custom',message});
  if(fields.length>20 || new Set(ids).size!==ids.length || new Set(spec.groups.map(g=>g.id)).size!==spec.groups.length) issue('字段/分组 ID 必须唯一，字段最多 20 个。');
  if(new TextEncoder().encode(JSON.stringify(spec)).length>64*1024) issue('表单定义最多 64 KiB。');
  for(const field of fields) {
    if((field.type==='number'||field.type==='date') && field.min!==undefined && field.max!==undefined && field.min>field.max) issue('最小值不能超过最大值。');
    if(field.default!==undefined && formValueError(field,field.default,{initial:true})) issue(`初始值无效：${field.label}`);
  }
});
export function validateFormValues(spec,values) {
  const parsed=formValuesSchema.safeParse(values);if(!parsed.success) return {ok:false,errors:{_form:'答复内容或大小不符合契约。'}};
  const fields=spec.groups.flatMap(g=>g.fields),errors=Object.create(null);
  for(const key of Object.keys(parsed.data)) if(!fields.some(f=>f.id===key)) errors._form='答复含未定义字段。';
  for(const field of fields) {const error=formValueError(field,parsed.data[field.id]);if(error)errors[field.id]=error;}
  return {ok:Object.keys(errors).length===0,errors,values:parsed.data};
}
export const formPublishSchema=z.object({key:id,artifactId:id.optional(),expectedVersion:revision,title:z.string().min(1).max(200),spec:formSchema}).strict();
export const formToolParameters=z.toJSONSchema(formPublishSchema,{io:'input'});
const commandBase={key:id,workspaceId:id,roomId:id,artifactId:id,version:revision.positive()};
export const formCommandTypes=['submitForm','continueForm'];
export const formCommandSchema=z.discriminatedUnion('type',[
  z.object({...commandBase,type:z.literal('submitForm'),expectedResponseRevision:revision,values:formValuesSchema}).strict(),
  z.object({...commandBase,type:z.literal('continueForm'),responseRevision:revision.positive(),expectedWaitRevision:revision.positive()}).strict(),
]);
export const formQuerySchema=z.discriminatedUnion('type',[z.object({type:z.literal('formState'),roomId:id,artifactId:id,version:revision.positive()}).strict(),z.object({type:z.literal('formResponses'),roomId:id,artifactId:id,version:revision.positive(),beforeRevision:revision.positive().optional(),limit:z.number().int().min(1).max(20).default(10)}).strict()]);
export const formResponseSchema=z.object({revision:revision.positive(),authorId:id,createdAt:z.string(),values:formValuesSchema,attachmentRefs:z.array(attachmentSchema).max(5)});
export const formStateSchema=z.object({artifactId:id,version:revision.positive(),latestVersion:revision.positive(),taskId:id,runId:id,ownerAgentId:id,roomId:id,goal:z.string(),status:z.enum(['waiting','pending','attempting','submitted','expired','unknown']),waitRevision:revision.positive(),responseRevision:revision,response:formResponseSchema.nullable(),canSubmit:z.boolean()});

export const formResponsesSchema=z.object({artifactId:id,version:revision.positive(),roomId:id,responses:z.array(formResponseSchema).max(20),beforeRevision:revision.positive().nullable()});
