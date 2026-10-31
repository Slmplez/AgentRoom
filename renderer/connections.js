/* Connection editor and launch picker. Secrets are never returned by the backend. */
window.createConnectionUI = ({ client, platform, showModal, beginModalLoad, modalCurrent, toast, icon, esc, modalAction }) => {
  const $ = selector => document.querySelector(selector);
  const protocols = { multi: '兼容网关 / 多协议', responses: 'OpenAI Responses', chat: 'OpenAI Chat Completions', anthropic: 'Anthropic Messages' };
  let editingId = '', connectionState = { profiles: [], secureStorageAvailable: false }, generation = 0;
  async function load() { connectionState = await client.query({ type: 'connections' }); }
  function profiles() { return connectionState.profiles; }
  function updateLaunchModel() {
    const profile = profiles().find(item => item.id === $('#launch-connection')?.value);
    $('#launch-model-fields').hidden = !profile;
    if (profile) {
      $('#launch-model').value = profile.model;
      $('#launch-connection-hint').textContent = `${profile.baseUrl} · ${profile.caPath ? '自定义 CA' : '系统信任链'} · 关闭窗口后模型转发会继续在托盘运行。`;
    }
  }
  function updateLaunch() {
    const select = $('#launch-connection'); if (!select) return;
    const tool = document.querySelector('[data-engine].selected')?.dataset.engine;
    const previous = select.value;
    select.innerHTML = `<option value="">使用 CLI 原配置</option>${profiles().filter(item => item.compatibleEngines.includes(tool)).map(item => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(item.model)}</option>`).join('')}`;
    if ([...select.options].some(item => item.value === previous)) select.value = previous;
    updateLaunchModel();
  }
  function decorateLaunch() {
    const label = $('#agent-directory').closest('.directory-row').previousElementSibling;
    label.insertAdjacentHTML('beforebegin', `<div class="form-label-row"><label class="form-label" for="launch-connection">连接方案</label><button class="text-link" data-action="connections">管理网关与模型 ${icon('arrow')}</button></div><select class="text-input" id="launch-connection"><option value="">使用 CLI 原配置</option></select><div id="launch-model-fields" hidden><label class="form-label" for="launch-model">本次使用的模型</label><input class="text-input" id="launch-model" maxlength="200" placeholder="模型 ID"><p class="form-hint" id="launch-connection-hint"></p></div>`);
    const current = modalCurrent(); void load().then(() => { if (current()) updateLaunch(); }).catch(error => { if (current()) toast(error.message); });
  }
  async function show(selectedId = '') {
    const current = beginModalLoad();
    const epoch = ++generation;
    try { await load(); } catch (error) { toast(error.message); return; }
    if (epoch !== generation || !current()) return;
    editingId = selectedId;
    const profile = profiles().find(item => item.id === selectedId) || { name: '', baseUrl: 'http://127.0.0.1:3425/v1', protocol: 'multi', model: '', authMode: 'bearer', contextWindow: 128000, maxTokens: 8192 };
    const file = (id, label, value, key = false) => `<label class="form-label" for="${id}">${label}</label><div class="directory-row"><input class="text-input" id="${id}" value="${esc(value || '')}" placeholder="可选 · PEM 文件路径"><button data-certificate="${id}" data-kind="${key ? 'key' : 'cert'}">选择文件</button></div>`;
    showModal('连接、网关与模型', '为不同 Agent 选择同一套模型服务，也可以接入本地模型或兼容网关。', `
      <div class="connections-layout"><aside class="connection-sidebar">
        <button class="button primary" data-action="connection-new">${icon('plus')} 新建连接方案</button>
        <div class="connection-profile-list">${profiles().map(item => `<button class="connection-profile ${item.id === selectedId ? 'selected' : ''}" data-connection="${esc(item.id)}"><strong>${esc(item.name)}</strong><small>${esc(protocols[item.protocol])}</small><span>${esc(item.model)}</span></button>`).join('') || '<p class="form-hint">添加一个连接方案，启动 Agent 时即可选择。</p>'}</div>
        <div class="connection-storage-note">${icon('settings')}<span>${connectionState.secureStorageAvailable ? 'Key 由系统加密保存' : '当前环境无法保存 Key，请使用桌面版'}<br>编辑时不回显已保存的 Key。</span></div>
      </aside><div class="connection-editor">
        <div class="connection-presets"><span>快速填写</span><button data-preset="magpie">兼容网关</button><button data-preset="ollama">Ollama</button><button data-preset="lmstudio">LM Studio</button><button data-preset="custom">自定义</button></div>
        <label class="form-label" for="connection-name">方案名称</label><input class="text-input" id="connection-name" maxlength="60" value="${esc(profile.name)}" placeholder="例如：公司网关、本地 Qwen">
        <div class="connection-form-row"><div><label class="form-label" for="connection-protocol">API 协议</label><select class="text-input" id="connection-protocol">${Object.entries(protocols).map(([id, label]) => `<option value="${id}" ${profile.protocol === id ? 'selected' : ''}>${esc(label)}</option>`).join('')}</select></div><div><label class="form-label" for="connection-auth">认证方式</label><select class="text-input" id="connection-auth"><option value="bearer" ${profile.authMode === 'bearer' ? 'selected' : ''}>Bearer API Key</option><option value="api-key" ${profile.authMode === 'api-key' ? 'selected' : ''}>x-api-key</option><option value="none" ${profile.authMode === 'none' ? 'selected' : ''}>无认证（本地服务）</option></select></div></div>
        <label class="form-label" for="connection-url">API Base URL</label><input class="text-input" id="connection-url" value="${esc(profile.baseUrl)}" placeholder="http://127.0.0.1:3425/v1"><p class="form-hint">填写 API 根路径，通常以 /v1 结尾；不要包含 /responses 或 /chat/completions。</p>
        <label class="form-label" for="connection-key">API Key ${profile.hasApiKey ? '<span class="saved-badge">已保存</span>' : ''}</label><input class="text-input" type="password" autocomplete="new-password" id="connection-key" placeholder="${profile.hasApiKey ? '留空保留已保存的 Key' : '输入服务商 Key 或 网关 Token'}"><label class="checkbox-label"><input type="checkbox" id="connection-clear-key">清除已保存的 Key</label>
        <label class="form-label" for="connection-model">默认模型 ID</label><div class="directory-row"><input class="text-input" id="connection-model" list="connection-model-list" value="${esc(profile.model)}" maxlength="200" placeholder="手动填写，或从网关读取模型"><datalist id="connection-model-list"></datalist><button data-action="connection-test">读取模型 / 测试</button></div>
        <div class="connection-test-result" id="connection-test-result" role="status">只发送 GET /models，检查网络、认证和模型列表，不执行推理。</div>
        <details class="connection-advanced" ${profile.caPath || profile.clientCertPath ? 'open' : ''}><summary>CA 认证与客户端证书 <span>HTTPS / mTLS</span></summary>
          ${file('connection-ca', '自定义 CA 证书 / 证书链', profile.caPath)}<p class="form-hint">保留系统信任链并添加此 CA，始终校验证书与域名。</p>
          ${file('connection-cert', '客户端证书（mTLS，可选）', profile.clientCertPath)}${file('connection-private-key', '客户端私钥（与客户端证书配套）', profile.clientKeyPath, true)}
          <label class="form-label" for="connection-passphrase">私钥口令 ${profile.hasPassphrase ? '<span class="saved-badge">已保存</span>' : ''}</label><input class="text-input" id="connection-passphrase" type="password" autocomplete="new-password" placeholder="${profile.hasPassphrase ? '留空保留原口令' : '可选'}"><label class="checkbox-label"><input type="checkbox" id="connection-clear-passphrase">清除已保存的口令</label>
        </details>
        <details class="connection-advanced"><summary>模型参数 <span>按实际模型能力填写</span></summary><div class="connection-form-row"><div><label class="form-label" for="connection-context">上下文 tokens</label><input class="text-input" id="connection-context" type="number" min="1024" max="10000000" value="${profile.contextWindow}"></div><div><label class="form-label" for="connection-max-tokens">最大输出 tokens</label><input class="text-input" id="connection-max-tokens" type="number" min="1" value="${profile.maxTokens}"></div></div><label class="checkbox-label"><input type="checkbox" id="connection-reasoning" ${profile.reasoning ? 'checked' : ''}>Pi 模型支持 reasoning</label></details>
        <p class="form-hint" id="connection-compatibility"></p>
      </div></div>`, `${selectedId ? '<button class="button danger" data-action="connection-delete">删除方案</button>' : ''}<button class="button" data-action="launch">启动 Agent</button><button class="button" data-action="close-modal">关闭</button><button class="button primary" data-action="connection-save">保存连接方案 ${icon('check')}</button>`, true);
    $('.modal').classList.add('connections-modal');
    compatibility();
  }
  function payload(testing = false) {
    return { ...(editingId ? { id: editingId } : {}), name: $('#connection-name').value || (testing ? '连接测试' : ''), protocol: $('#connection-protocol').value,
      baseUrl: $('#connection-url').value, authMode: $('#connection-auth').value, apiKey: $('#connection-key').value, clearApiKey: $('#connection-clear-key').checked,
      model: $('#connection-model').value || (testing ? 'model-pending' : ''), caPath: $('#connection-ca').value, clientCertPath: $('#connection-cert').value,
      clientKeyPath: $('#connection-private-key').value, clientKeyPassphrase: $('#connection-passphrase').value, clearPassphrase: $('#connection-clear-passphrase').checked,
      contextWindow: Number($('#connection-context').value), maxTokens: Number($('#connection-max-tokens').value), reasoning: $('#connection-reasoning').checked };
  }
  function writePayload(testing = false) {
    const { id, apiKey, clientKeyPassphrase, clearApiKey, clearPassphrase, ...profile } = payload(testing);
    const change = (value, clear) => clear ? { action: 'clear' } : value ? { action: 'replace', value } : { action: 'keep' };
    return { id, profile, credentials: { apiKey: change(apiKey, clearApiKey), passphrase: change(clientKeyPassphrase, clearPassphrase) } };
  }
  function compatibility() {
    const labels = { multi: 'Codex、Claude Code、Pi、OpenCode。需要上游网关支持多协议转换。', responses: 'Codex、Pi、OpenCode。上游需要支持 Responses API。', chat: 'Pi、OpenCode。Codex 需要 Responses，Claude Code 需要 Anthropic 协议。', anthropic: 'Claude Code、Pi、OpenCode。上游需要支持 Anthropic Messages API。' };
    if ($('#connection-compatibility')) $('#connection-compatibility').textContent = `适用引擎：${labels[$('#connection-protocol').value]}`;
  }
  document.addEventListener('change', event => {
    if (event.target.id === 'launch-connection') updateLaunchModel();
    if (event.target.id === 'connection-protocol') compatibility();
  });
  document.addEventListener('click', async event => {
    const button = event.target.closest('button'); if (!button) return;
    if (button.dataset.connection) return show(button.dataset.connection);
    if (button.dataset.certificate) {
      try { const value = await platform.chooseCertificate(button.dataset.kind); if (value && $(`#${button.dataset.certificate}`)) $(`#${button.dataset.certificate}`).value = value; else if (!platform.capabilities.chooseCertificate) toast('浏览器预览请手动填写证书路径。'); } catch (error) { toast(error.message); }
      return;
    }
    if (button.dataset.preset) {
      const presets = { magpie: ['兼容网关', 'http://127.0.0.1:3425/v1', 'multi', 'bearer'], ollama: ['Ollama', 'http://127.0.0.1:11434/v1', 'chat', 'none'], lmstudio: ['LM Studio', 'http://127.0.0.1:1234/v1', 'chat', 'none'], custom: ['', '', 'responses', 'bearer'] };
      const values = presets[button.dataset.preset];
      // A preset starts a fresh profile so an old saved credential is never reused at a new host.
      await show();
      ['connection-name', 'connection-url', 'connection-protocol', 'connection-auth'].forEach((id, index) => { $(`#${id}`).value = values[index]; });
      compatibility(); return;
    }
    const action = button.dataset.action;
    if (action === 'connections' || action === 'connection-new') return show();
    if (action === 'connection-save') return modalAction(button, async () => {
      const result = await client.dispatch({ type: 'saveConnection', key: crypto.randomUUID(), ...writePayload() }); if (!button.isConnected) return; await show(result.entityId); toast('连接方案已保存，可在启动 Agent 时选择。');
    });
    if (action === 'connection-delete') return modalAction(button, async () => { await client.dispatch({ type: 'removeConnection', key: crypto.randomUUID(), id: editingId }); if (!button.isConnected) return; await show(); toast('连接方案已删除；正在运行的会话继续使用启动时的配置。'); });
    if (action === 'connection-test') {
      const status = $('#connection-test-result'), models = $('#connection-model-list'), model = $('#connection-model');
      return modalAction(button, async () => {
        status.textContent = '正在检查网络、TLS 和 GET /models…'; status.className = 'connection-test-result';
        let result;
        try { result = await client.query({ type: 'testConnection', ...writePayload(true) }); }
        catch (error) { if (status.isConnected) { status.textContent = error.message; status.className = 'connection-test-result error'; } return; }
        if (!status.isConnected) return;
        status.textContent = `${result.message}${result.latencyMs != null ? ` ${result.latencyMs} ms` : ''}`;
        status.className = `connection-test-result ${result.ok ? 'success' : 'error'}`;
        models.innerHTML = (result.models || []).map(id => `<option value="${esc(id)}"></option>`).join('');
        if (!model.value && result.models?.length) model.value = result.models[0];
      });
    }
  });
  return { show, decorateLaunch, updateLaunch, launchPayload: () => ({ connectionId: $('#launch-connection')?.value || '', ...($('#launch-connection')?.value ? { model: $('#launch-model').value } : {}) }) };
};
