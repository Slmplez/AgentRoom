const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { PROTOCOLS } = require('./connection-profiles.cjs');

async function engineConnection(tool, profile, gateway, dataDir, overrideModel) {
  if (!PROTOCOLS[profile.protocol]?.engines.includes(tool)) throw new Error('此引擎不支持所选连接方案的协议，请选择兼容方案或使用 CLI 原配置。');
  const model = overrideModel === undefined ? profile.model : String(overrideModel).trim();
  if (!model || model.length > 200 || /[\r\n\0]/.test(model)) throw new Error('请输入有效的模型 ID。');
  const env = {}, args = [];
  const endpoint = `${gateway.baseUrl}/v1`;
  const provider = 'agent_room';
  if (tool === 'codex') {
    env.AGENT_ROOM_GATEWAY_KEY = gateway.token;
    const values = {
      model_provider: provider, model,
      [`model_providers.${provider}.name`]: profile.name,
      [`model_providers.${provider}.base_url`]: endpoint,
      [`model_providers.${provider}.env_key`]: 'AGENT_ROOM_GATEWAY_KEY',
      [`model_providers.${provider}.wire_api`]: 'responses',
      [`model_providers.${provider}.requires_openai_auth`]: false,
      [`model_providers.${provider}.supports_websockets`]: false,
    };
    for (const [key, value] of Object.entries(values)) args.push('-c', `${key}=${JSON.stringify(value)}`);
  } else if (tool === 'claude') {
    Object.assign(env, { ANTHROPIC_BASE_URL: gateway.baseUrl, ANTHROPIC_API_KEY: gateway.token, ANTHROPIC_AUTH_TOKEN: gateway.token,
      ANTHROPIC_MODEL: model, ANTHROPIC_DEFAULT_OPUS_MODEL: model, ANTHROPIC_DEFAULT_SONNET_MODEL: model, ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0' });
    args.push('--model', model);
  } else if (tool === 'opencode') {
    const api = profile.protocol === 'multi' ? 'chat' : profile.protocol;
    const npm = { chat: '@ai-sdk/openai-compatible', responses: '@ai-sdk/openai', anthropic: '@ai-sdk/anthropic' }[api];
    env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: `${provider}/${model}`, small_model: `${provider}/${model}`,
      provider: { [provider]: { npm, name: profile.name, options: { baseURL: endpoint, apiKey: gateway.token }, models: { [model]: { name: model, limit: { context: profile.contextWindow, output: profile.maxTokens } } } } } });
    args.push('--model', `${provider}/${model}`);
  } else if (tool === 'pi') {
    const api = { chat: 'openai-completions', responses: 'openai-responses', anthropic: 'anthropic-messages', multi: 'openai-responses' }[profile.protocol];
    const config = { name: profile.name, baseUrl: api === 'anthropic-messages' ? gateway.baseUrl : endpoint, apiKey: gateway.token, api,
      models: [{ type: 'chat', id: model, name: model, reasoning: profile.reasoning, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: profile.contextWindow, maxTokens: profile.maxTokens }] };
    const dir = path.join(dataDir, 'runtime'); await fs.mkdir(dir, { recursive: true });
    const extension = path.join(dir, `pi-provider-${crypto.randomUUID()}.mjs`);
    await fs.writeFile(extension, `// Generated per-session provider; contains only a temporary local gateway credential.\nexport default function (pi) { pi.registerProvider(${JSON.stringify(provider)}, ${JSON.stringify(config)}); }\n`, { mode: 0o600 });
    args.push('--extension', extension, '--provider', provider, '--model', model);
  }
  return { args, env, model };
}
module.exports = { engineConnection };
