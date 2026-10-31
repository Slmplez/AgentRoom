import { open, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { createPiMemoryCuratorEngine } from './pi-memory-curator.mjs';
import { inspectPiStopped } from './consultation-agents.mjs';
const require = createRequire(import.meta.url);
const { validateProfile } = require('./connection-profiles.cjs');
const { startGateway } = require('./model-gateway.cjs');
const { engineConnection } = require('./engine-connections.cjs');

const envName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,99}$/).refine(name => !['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'PI_CODING_AGENT_DIR'].includes(name.toUpperCase()));
export const memoryCuratorConfigSchema = z.object({
  version: z.literal(1), agentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/),
  displayName: z.string().trim().min(1).max(60), model: z.string().trim().min(1).max(200),
  connection: z.object({
    baseUrl: z.string().min(1).max(2048), protocol: z.enum(['chat', 'responses', 'anthropic']),
    authMode: z.enum(['bearer', 'api-key', 'none']), credentialEnv: envName.optional(),
    contextWindow: z.number().int().min(32768).max(10000000).default(128000),
    maxTokens: z.number().int().min(1).max(8192).default(8192),
  }).strict(),
}).strict().superRefine((config, ctx) => {
  if ((config.connection.authMode === 'none') === Boolean(config.connection.credentialEnv)) ctx.addIssue({ code: 'custom', message: 'Authentication and credential environment reference disagree.' });
});

// Trusted startup configuration only. Loading validates data but starts no
// gateway, child process, credential discovery or model request.
export async function loadMemoryCuratorConfig(file, { env = process.env } = {}) {
  let parsed, profile, apiKey;
  const handle = await open(resolve(file), 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > 65536) throw Error();
    const buffer = Buffer.alloc(65537); let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
      if (!bytesRead) break; length += bytesRead;
    }
    if (length > 65536) throw Error();
    parsed = memoryCuratorConfigSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))));
    profile = validateProfile({ ...parsed.connection, name: parsed.displayName, model: parsed.model });
    apiKey = parsed.connection.credentialEnv ? env[parsed.connection.credentialEnv] : '';
    if (profile.authMode !== 'none' && (typeof apiKey !== 'string' || !apiKey || apiKey.length > 4096 || /[\0\r\n]/.test(apiKey))) throw Error();
  } catch { throw Error('后台整理配置无效或凭据环境变量不可用。配置须为 64 KiB 内的受支持 JSON，模型输出上限为 8192 tokens。'); }
  finally { await handle.close(); }

  return Object.freeze({ agentId: parsed.agentId, model: parsed.model, displayName: parsed.displayName, inspectStopped: inspectPiStopped,
    async createEngine({ executionTag }) {
      if (!/^[a-f0-9-]{36}$/.test(executionTag || '')) throw Error('Invalid curator execution tag.');
      const directory = await mkdtemp(join(tmpdir(), 'agentroom-curator-provider-'));
      let gateway, engine;
      try {
        gateway = await startGateway(profile, { apiKey });
        const config = await engineConnection('pi', profile, gateway, directory);
        const childEnv = { ...env, ...config.env };
        if (parsed.connection.credentialEnv) delete childEnv[parsed.connection.credentialEnv];
        engine = await createPiMemoryCuratorEngine({ args: config.args, env: childEnv, executionTag });
        return { ...engine, async close() {
          gateway.close();
          await engine.close();
          if (engine.isStopped()) await rm(directory, { recursive: true, force: true });
        } };
      } catch {
        gateway?.close(); await engine?.close();
        if (!engine || engine.isStopped()) await rm(directory, { recursive: true, force: true });
        throw Error('无法创建后台整理引擎，请检查受信模型连接。');
      }
    },
  });
}
