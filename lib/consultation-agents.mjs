import { readFile, stat, mkdtemp, rm } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z } from 'zod';
import { createPiQuestionEngine } from './local-question-engine.mjs';
const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const { validateProfile } = require('./connection-profiles.cjs');
const { startGateway } = require('./model-gateway.cjs');
const { engineConnection } = require('./engine-connections.cjs');
const name = z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/).max(100);
const connection = z.object({ baseUrl: z.string().min(1).max(2048), protocol: z.enum(['chat','responses','anthropic']), authMode: z.enum(['bearer','api-key','none']), credentialEnv: name.optional(), contextWindow: z.number().int().min(1024).max(10000000).default(128000), maxTokens: z.number().int().min(1).max(8192).default(2048) }).strict();
const agent = z.object({ id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/), displayName: z.string().trim().min(1).max(100), directory: z.string().min(1), provider: z.string().min(1).max(100), model: z.string().min(1).max(200), envBindings: z.record(name, name).default({}), connection: connection.optional() }).strict();
const configuration = z.object({ version: z.literal(1), agents: z.array(agent).min(1).max(20) }).strict();

// Check only the unique persisted command-line marker, never signal a PID from
// an old host. A reused PID cannot release a lease or cause a foreign kill.
export async function inspectPiStopped(tag, { platform = process.platform, run = exec } = {}) {
  if (!/^[a-f0-9-]{36}$/.test(tag || '')) return false;
  try {
    const marker = 'AGENTROOM_EXECUTION_' + tag;
    if (platform === 'win32') {
      const script = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -ErrorAction Stop -Filter "Name='node.exe' OR Name='pi.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${marker}') -and $_.CommandLine.Contains('--append-system-prompt') } | Select-Object -ExpandProperty ProcessId).Count`;
      const { stdout, stderr } = await run(join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-Command',script], { windowsHide: true, timeout: 5000, maxBuffer: 4096 });
      return !stderr?.trim() && stdout.trim() === '0';
    }
    const { stdout, stderr } = await run('ps', ['-eo','pid=,comm=,args='], { timeout: 5000, maxBuffer: 1024 * 1024 });
    if (stderr?.trim()) return false;
    return !stdout.split('\n').some(line => /^\s*\d+\s+(?:node|pi)\b/.test(line) && line.includes(marker) && line.includes('--append-system-prompt'));
  } catch { return false; }
}

// Read only by the trusted host at startup. HTTP cannot write this file or set
// argv, directories, model selection or environment bindings.
export async function loadConsultationAgents(file, { env = process.env } = {}) {
  const absolute = resolve(file), info = await stat(absolute);
  if (!info.isFile() || info.size > 65536) throw Error('Consultation configuration must be a JSON file under 64 KiB.');
  const parsed = configuration.parse(JSON.parse(await readFile(absolute, 'utf8')));
  if (new Set(parsed.agents.map(a => a.id)).size !== parsed.agents.length) throw Error('Consultation Agent IDs must be unique.');
  const result = [];
  for (const a of parsed.agents) {
    const directory = resolve(dirname(absolute), a.directory);
    if (!(await stat(directory)).isDirectory()) throw Error('Consultation Agent workspace must be a directory.');
    const agentEnv = { ...env };
    for (const [target, source] of Object.entries(a.envBindings)) {
      if (!env[source]) throw Error('A consultation credential environment binding is unavailable.');
      // Bind model credentials only; process execution/configuration stays host-owned.
      if (!/^(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|GROQ_API_KEY|OPENROUTER_API_KEY|MISTRAL_API_KEY|XAI_API_KEY|DEEPSEEK_API_KEY)$/.test(target)) throw Error('Only supported provider credential variables may be bound.');
      agentEnv[target] = env[source];
    }
    const profile = a.connection && validateProfile({ ...a.connection, name: a.displayName, model: a.model });
    const apiKey = a.connection?.credentialEnv ? env[a.connection.credentialEnv] : '';
    if (profile && profile.authMode !== 'none' && !apiKey) throw Error('The consultation model credential environment variable is unavailable.');
    result.push({ id: a.id, displayName: a.displayName, engine: 'pi', model: a.model,
      async createEngine({ executionTag }) {
        if (!profile) return createPiQuestionEngine({ directory, env: { ...agentEnv }, args: ['--provider',a.provider,'--model',a.model], executionTag });
        const temporary = await mkdtemp(join(tmpdir(),'agentroom-consult-provider-'));
        let gateway, engine;
        const close = async () => { try { await engine?.close(); } finally { gateway?.close(); await rm(temporary,{recursive:true,force:true}); } };
        try {
          gateway = await startGateway(profile,{apiKey});
          const config = await engineConnection('pi',profile,gateway,temporary);
          engine = createPiQuestionEngine({ directory,env:{...agentEnv,...config.env},args:config.args,executionTag });
          return { ...engine,close };
        } catch(error) { await close(); throw error; }
      }, inspectStopped: inspectPiStopped,
    });
  }
  return result;
}
