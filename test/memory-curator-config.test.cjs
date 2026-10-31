const { test } = require('node:test');
const assert = require('node:assert/strict');
const { mkdtemp, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const base = { version: 1, agentId: 'memory-curator', displayName: '记忆整理员', model: 'configured-model', connection: { baseUrl: 'http://127.0.0.1:9', protocol: 'chat', authMode: 'bearer', credentialEnv: 'CURATOR_API_KEY' } };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ar-curator-config-'));
  const { loadMemoryCuratorConfig } = await import('../lib/memory-curator-config.mjs');
  return async (value = base, env = { ...process.env, CURATOR_API_KEY: 'SECRET-MUST-NOT-LEAK' }) => {
    const file = join(directory, randomUUID() + '.json'); await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
    return loadMemoryCuratorConfig(file, { env });
  };
}

test('trusted config loads without contacting provider, exposes identity only, and closes unstarted engine', async () => {
  const load = await fixture(), value = await load();
  assert.equal(value.agentId, 'memory-curator'); assert.equal(value.model, 'configured-model');
  assert.equal(typeof value.createEngine, 'function'); assert.equal(typeof value.inspectStopped, 'function');
  assert.deepEqual(JSON.parse(JSON.stringify(value)), { agentId: 'memory-curator', model: 'configured-model', displayName: '记忆整理员' });
  const engine = await value.createEngine({ executionTag: randomUUID() });
  assert.equal(engine.isStopped(), true); await engine.close();
});

test('malformed, executable, oversized, missing-credential and unsupported configs are rejected without leaking values', async () => {
  const load = await fixture();
  const cases = [
    { ...base, args: ['--tools', 'bash'] }, { ...base, directory: 'C:/private' },
    { ...base, apiKey: 'SECRET-MUST-NOT-LEAK' },
    { ...base, connection: { ...base.connection, maxTokens: 8193 } },
    { ...base, connection: { ...base.connection, protocol: 'file' } },
    { ...base, connection: { ...base.connection, baseUrl: 'https://user:SECRET-MUST-NOT-LEAK@example.com' } },
    { ...base, connection: { ...base.connection, credentialEnv: 'PATH' } },
    { ...base, connection: { ...base.connection, authMode: 'none' } },
    '{"bad":"SECRET-MUST-NOT-LEAK"', ' '.repeat(65537),
  ];
  for (const value of cases) await assert.rejects(() => load(value), error => !error.message.includes('SECRET-MUST-NOT-LEAK') && error.message.includes('后台整理配置无效'));
  await assert.rejects(() => load(base, {}), /凭据环境变量不可用/);
  await assert.rejects(() => load(base, { CURATOR_API_KEY: 'key\ninjected' }), /凭据环境变量不可用/);
});

test('no-auth configuration is explicit, bounded, and does not require ambient credentials', async () => {
  const load = await fixture();
  const result = await load({ ...base, connection: { baseUrl: 'http://127.0.0.1:9', protocol: 'responses', authMode: 'none', maxTokens: 1024 } }, process.env);
  assert.equal(result.model, 'configured-model');
  await assert.rejects(() => result.createEngine({ executionTag: 'arbitrary-process' }), /Invalid curator execution tag/);
});
