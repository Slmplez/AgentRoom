import { z } from 'zod';
const id = z.string().min(1).max(300);
const short = z.string().max(200), text = z.string().max(4000);
/** @template {import('zod').ZodRawShape} T @param {T} shape */
const item = shape => z.object(shape).strict();
const props = {
  Section: item({ title: short, description: text }),
  Metrics: item({ items: z.array(item({ label: short, value: short, detail: text })).max(20) }),
  Bars: item({ title: short, items: z.array(item({ label: short, value: z.number().finite().min(0).max(100) })).max(50) }),
  Table: item({ columns: z.array(short).min(1).max(20), rows: z.array(z.array(z.string().max(2000)).max(20)).max(200) }).superRefine((p,c) => { if(p.rows.some(r=>r.length!==p.columns.length)) c.addIssue({code:'custom',message:'Table row length mismatch'}); }),
};
export const reportSchema = item({ root: id, elements: z.record(id, item({ type: z.enum(['Section','Metrics','Bars','Table']), props: z.unknown(), children: z.array(id).max(100).default([]) })) }).superRefine((spec, ctx) => {
  const entries = Object.entries(spec.elements), visited = new Set();
  const invalid = () => ctx.addIssue({ code: 'custom', message: 'Invalid or oversized report tree' });
  if (entries.length > 100 || entries.some(([key])=>['__proto__','constructor','prototype'].includes(key))) { invalid(); return; }
  for (const [,node] of entries) if (!props[node.type].safeParse(node.props).success || (node.type !== 'Section' && node.children.length)) { invalid(); return; }
  function walk(key, depth) {
    if (depth > 8 || visited.has(key) || !Object.hasOwn(spec.elements,key)) return false;
    visited.add(key); return spec.elements[key].children.every(child=>walk(child, depth+1));
  }
  if (!walk(spec.root,1) || visited.size!==entries.length) invalid();
  if (new TextEncoder().encode(JSON.stringify(spec)).byteLength > 256*1024) invalid();
});
export const artifactPublishSchema = item({ key: id, artifactId: id.optional(), expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER-1), title: short.min(1), catalogVersion: z.literal(1), spec: reportSchema });
// Give the model the complete component grammar. Runtime refinements additionally
// enforce tree shape, row lengths and total bytes; JSON Schema alone cannot.
export const artifactToolParameters = z.toJSONSchema(artifactPublishSchema);
artifactToolParameters.properties.spec.properties.elements.additionalProperties = {
  oneOf: Object.entries(props).map(([type, schema]) => z.toJSONSchema(item({
    type: z.literal(type), props: schema,
    children: z.array(id).max(type === 'Section' ? 100 : 0).default([]),
  }))),
};
export const artifactRefSchema = item({ artifactId: id, version: z.number().int().positive(), title: short, catalogVersion: z.literal(1) });
export const artifactMetadataSchema = item({
  artifactId: id, version: z.number().int().positive(), roomId: id, taskId: id,
  runId: id, producerAgentId: id, title: short, catalogVersion: z.number().int().positive(),
  createdAt: z.string(), contentHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const artifactVersionSchema = artifactMetadataSchema.extend({ catalogVersion: z.literal(1), spec: reportSchema });
export const artifactVersionsSchema = item({ versions: z.array(artifactMetadataSchema).max(100), beforeVersion: z.number().int().positive().nullable() });
export const artifactQuerySchema = z.discriminatedUnion('type', [
  item({ type: z.literal('artifact'), roomId: id, artifactId: id, version: z.number().int().positive() }),
  item({ type: z.literal('artifactVersions'), roomId: id, artifactId: id, beforeVersion: z.number().int().positive().optional(), limit: z.number().int().min(1).max(100).default(20) }),
]);
