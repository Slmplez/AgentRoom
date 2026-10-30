import { clientError } from '../../contracts/chat.mjs';
import models from '../../shared/model-catalog.cjs';

export function createMockSettings() {
  let profiles = [], nextId = 0, failure = '';
  const engines = { multi: ['codex', 'claude', 'pi', 'opencode'], responses: ['codex', 'pi', 'opencode'], chat: ['pi', 'opencode'], anthropic: ['claude', 'pi', 'opencode'] };
  function validate(command) {
    let url; try { url = new URL(command.profile.baseUrl); } catch { throw clientError('invalid_connection', '请输入完整 HTTP / HTTPS 地址。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw clientError('invalid_connection', '请将认证信息放入专用凭证输入。');
    if (command.profile.maxTokens > command.profile.contextWindow) throw clientError('invalid_connection', '最大输出不能超过上下文。');
    const old = profiles.find(p => p.id === command.id);
    if (command.id && !old) throw clientError('not_found', '连接配置不存在。');
    const flag = (change, previous) => change.action === 'keep' ? Boolean(previous) : change.action === 'replace';
    const hasApiKey = flag(command.credentials.apiKey, old?.hasApiKey), hasPassphrase = flag(command.credentials.passphrase, old?.hasPassphrase);
    if (command.profile.authMode !== 'none' && !hasApiKey) throw clientError('invalid_connection', '请填写模拟 Key，或选择无认证。');
    return { ...command.profile, hasApiKey, hasPassphrase, compatibleEngines: engines[command.profile.protocol] };
  }
  return {
    query(input) {
      if (failure === input.type) { failure = ''; throw clientError('simulated_failure', '模拟读取失败。'); }
      if (input.type === 'connections') return structuredClone({ profiles, secureStorageAvailable: true, simulated: true });
      const profile = input.type === 'modelCatalog' ? profiles.find(p => p.id === input.connectionId) : validate(input);
      if (!profile) throw clientError('not_found', '连接配置不存在。');
      const catalog = models.catalogModels([
        { id: 'example', display_name: '示例工具模型', tool_call: true, streaming: true, reasoning: true, modalities: { input: ['text', 'image'] }, context_window: 128000, max_output_tokens: 8192 },
        { id: 'text-only', display_name: '纯文本模型', tool_call: false },
        { id: 'unverified', display_name: '能力未知模型' },
      ], profile.protocol, input.model ?? profile.model);
      return { ok: true, message: '模拟连接检查通过，未请求真实模型。', models: catalog.filter(m => m.source === 'upstream').map(m => m.id), catalog, latencyMs: 0 };
    },
    execute(command) {
      if (failure === command.type) { failure = ''; throw clientError('simulated_failure', '模拟保存失败，原配置保留。'); }
      if (command.type === 'removeConnection') {
        if (!profiles.some(p => p.id === command.id)) throw clientError('not_found', '连接配置不存在。');
        profiles = profiles.filter(p => p.id !== command.id);
        return { accepted: true, operationId: `mock-remove-${++nextId}`, entityId: command.id };
      }
      const record = { ...validate(command), id: command.id || `mock-connection-${++nextId}` };
      profiles = [...profiles.filter(p => p.id !== record.id), record];
      return { accepted: true, operationId: `mock-save-${++nextId}`, entityId: record.id };
    },
    failNext(type) { failure = type; },
    reset() { profiles = []; nextId = 0; failure = ''; },
  };
}
