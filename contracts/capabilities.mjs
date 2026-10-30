import { z } from 'zod';
const id = z.string().min(1).max(300), text = z.string().max(8192);
const credentialArgument = /(?:^|[^a-z])(?:token|key|secret|password|passwd|authorization|credential|headers?)(?:$|[^a-z])|^-H$/i;
export function publicCapabilityServer(input) {
  const value = { ...input, args: [...(input.args || [])] }; let redacted = false;
  if (value.url) {
    try { const url = new URL(value.url); if (url.search || url.username || url.password) { url.search = ''; url.username = ''; url.password = ''; value.url = url.href; redacted = true; } } catch { /* Invalid URLs are rejected by the server configuration writer. */ }
  }
  for (let i = 0; i < value.args.length; i++) {
    if (/^https?:\/\//i.test(value.args[i])) {
      const safe = publicCapabilityServer({ url: value.args[i] });
      if (safe.redacted) { value.args[i] = safe.url; redacted = true; }
    }
    if (credentialArgument.test(value.args[i])) {
      redacted = true;
      if (/^-/.test(value.args[i]) && value.args[i].includes('=')) value.args[i] = value.args[i].split('=')[0] + '=[redacted]';
      else if (/^-/.test(value.args[i]) && i + 1 < value.args.length) value.args[++i] = '[redacted]';
      else value.args[i] = '[redacted]';
    }
  }
  return { ...value, redacted };
}
const server = z.object({ name: z.string().trim().min(1).max(80), transport: z.enum(['stdio', 'http', 'sse']), command: text.optional(), args: z.array(text).max(100).default([]), url: text.optional(), enabled: z.boolean(), isolation: z.enum(['session', 'workspace']), disabledTools: z.array(text).max(1000).default([]) });
export const capabilityCommands = [
  z.object({ type: z.literal('saveCapabilityServer'), key: id, server: server.extend({ id: id.optional(), env: z.record(z.string().max(200), text).optional(), headers: z.record(z.string().max(200), text).optional() }).refine(value => !publicCapabilityServer(value).redacted, 'URL 查询参数及凭证命令参数不能公开保存，请使用加密环境变量或请求头。') }),
  z.object({ type: z.literal('importSkill'), key: id, id: id.optional(), directory: z.string().min(1).max(2048) }),
  z.object({ type: z.literal('removeCapability'), key: id, kind: z.enum(['servers', 'skills']), id }),
  z.object({ type: z.literal('bindCapabilities'), key: id, workspaceId: id, serverIds: z.array(id), skillIds: z.array(id) }),
];
export const capabilityQueries = [z.object({ type: z.literal('capabilities') }), z.object({ type: z.literal('testCapabilityServer'), id, workspaceId: id })];
export const capabilityQueryResults = {
  capabilities: z.object({
    servers: z.array(server.extend({ id, revision: z.number(), envKeys: z.array(z.string()), headerKeys: z.array(z.string()), redacted: z.boolean().default(false) })),
    skills: z.array(z.object({ id, name: z.string(), description: z.string(), revision: z.number(), files: z.number(), hash: z.string(), source: z.string() })),
    bindings: z.array(z.object({ workspaceId: id, serverIds: z.array(id), skillIds: z.array(id) })),
    secureStorageAvailable: z.boolean(), error: z.string(), simulated: z.boolean().default(false),
    agents: z.array(z.object({ agentId: id, status: z.string(), servers: z.array(z.object({ id, name: z.string(), enabled: z.boolean() })), skills: z.array(z.object({ id, name: z.string() })), errors: z.array(z.string()) })).default([]),
  }),
  testCapabilityServer: z.object({ ok: z.boolean(), message: z.string(), tools: z.array(z.object({ name: z.string(), description: z.string() })) }),
};
