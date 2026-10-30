// Pure model metadata and compatibility rules shared by the backend and Mock.
// A provider declaration is not evidence of a successful inference request.
const ENGINE_PROTOCOLS = { codex: ['responses'], claude: ['anthropic'], pi: ['responses', 'chat', 'anthropic'], opencode: ['chat', 'responses', 'anthropic'] };
const bool = (...values) => values.find(value => typeof value === 'boolean') ?? null;
const limit = (...values) => values.find(value => Number.isInteger(value) && value > 0 && value <= 10000000) ?? null;
const safeText = (value, max = 200) => typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : '';
function describeModel(row, source = 'upstream') {
  const item = typeof row === 'string' ? { id: row } : row;
  if (!item || typeof item !== 'object') return null;
  const id = safeText(item.id || item.name);
  if (!id) return null;
  const caps = item.capabilities || {}, input = item.modalities?.input || item.architecture?.input_modalities;
  return { id, name: safeText(item.display_name || item.name) || id, source,
    capabilities: {
      tools: bool(item.tool_call, caps.supports_tool_use, Array.isArray(item.supported_parameters) ? item.supported_parameters.includes('tools') : null),
      images: bool(caps.supports_images, Array.isArray(input) ? input.includes('image') : null),
      streaming: bool(item.streaming, caps.supports_streaming),
      reasoning: bool(item.reasoning, caps.supports_reasoning),
      contextWindow: limit(item.context_window, item.context_length, item.max_input_tokens),
      maxOutputTokens: limit(item.max_output_tokens, item.top_provider?.max_completion_tokens),
    } };
}
function modelCompatibility(protocol, model, engineId) {
  const supported = ENGINE_PROTOCOLS[engineId];
  if (!supported || (protocol !== 'multi' && !supported.includes(protocol))) return { engineId, status: 'incompatible', reason: '此引擎不支持该连接的 API 协议。' };
  if (model.capabilities.tools === false) return { engineId, status: 'incompatible', reason: '供应商声明该模型不支持工具调用，无法用于此编码智能体。' };
  if (model.capabilities.streaming === false) return { engineId, status: 'incompatible', reason: '供应商声明该模型不支持流式输出。' };
  const known = model.capabilities.tools === true && model.capabilities.streaming === true;
  return { engineId, status: known ? 'compatible' : 'unknown', reason: known ? '协议与已声明能力匹配；尚未验证实际推理。' : '协议匹配，但工具调用或流式能力尚未声明；可手动使用，需实际验证。' };
}
function catalogModels(rows, protocol, fallbackModel = '') {
  const entries = new Map();
  for (const row of rows) { const model = describeModel(row); if (model && !entries.has(model.id)) entries.set(model.id, model); if (entries.size >= 1000) break; }
  const manual = describeModel(fallbackModel, 'manual');
  if (manual && !entries.has(manual.id)) entries.set(manual.id, manual);
  return [...entries.values()].map(model => ({ ...model, compatibility: Object.keys(ENGINE_PROTOCOLS).map(engine => modelCompatibility(protocol, model, engine)) }));
}
module.exports = { ENGINE_PROTOCOLS, describeModel, modelCompatibility, catalogModels };
