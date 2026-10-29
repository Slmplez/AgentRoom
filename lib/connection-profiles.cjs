const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const tls = require('node:tls');

const PROTOCOLS = {
  responses: { label: 'OpenAI Responses', engines: ['codex', 'pi', 'opencode'] },
  chat: { label: 'OpenAI Chat Completions', engines: ['pi', 'opencode'] },
  anthropic: { label: 'Anthropic Messages', engines: ['claude', 'pi', 'opencode'] },
  multi: { label: 'Magpie / 多协议网关', engines: ['codex', 'claude', 'pi', 'opencode'] },
};
function field(value, max = 512) {
  if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value)) throw new Error('配置内容格式不正确或过长。');
  return value.trim();
}
function validateProfile(input) {
  const name = field(input?.name, 60);
  if (!name) throw new Error('请输入连接方案名称。');
  if (!Object.hasOwn(PROTOCOLS, input.protocol)) throw new Error('请选择受支持的 API 协议。');
  let url;
  try { url = new URL(field(input.baseUrl, 2048)); } catch { throw new Error('请输入完整的 HTTP / HTTPS API Base URL。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 只支持 HTTP / HTTPS，请将认证信息填入 API Key。');
  const model = field(input.model, 200);
  if (!model) throw new Error('请输入模型 ID，也可以先读取模型列表。');
  if (!['bearer', 'api-key', 'none'].includes(input.authMode)) throw new Error('请选择认证方式。');
  const certPaths = {};
  for (const key of ['caPath', 'clientCertPath', 'clientKeyPath']) {
    certPaths[key] = field(input[key] || '', 2048);
    if (certPaths[key] && !path.isAbsolute(certPaths[key])) throw new Error('证书文件需要使用完整路径。');
  }
  if (Boolean(certPaths.clientCertPath) !== Boolean(certPaths.clientKeyPath)) throw new Error('mTLS 需要同时提供客户端证书和私钥。');
  if (Object.values(certPaths).some(Boolean) && url.protocol !== 'https:') throw new Error('CA 和客户端证书仅用于 HTTPS 连接。');
  const contextWindow = Number(input.contextWindow || 128000), maxTokens = Number(input.maxTokens || 8192);
  if (!Number.isInteger(contextWindow) || contextWindow < 1024 || contextWindow > 10000000 || !Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > contextWindow) throw new Error('请填写有效的上下文和最大输出 token 数。');
  return { name, protocol: input.protocol, baseUrl: url.href.replace(/\/+$/, ''), model, authMode: input.authMode, ...certPaths, contextWindow, maxTokens, reasoning: Boolean(input.reasoning) };
}
async function tlsOptions(profile, secrets = {}) {
  if (!profile.baseUrl.startsWith('https:')) return {};
  const options = { rejectUnauthorized: true };
  try {
    if (profile.caPath) {
      const pem = await fs.readFile(profile.caPath, 'utf8');
      const certs = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
      if (!certs?.length) throw new Error();
      for (const cert of certs) new crypto.X509Certificate(cert);
      options.ca = [...tls.rootCertificates, ...certs];
    }
    if (profile.clientCertPath) {
      options.cert = await fs.readFile(profile.clientCertPath);
      options.key = await fs.readFile(profile.clientKeyPath);
      if (secrets.clientKeyPassphrase) options.passphrase = secrets.clientKeyPassphrase;
    }
    tls.createSecureContext(options);
  } catch { throw new Error('证书无法读取或格式不正确，请检查 PEM CA、客户端证书、私钥和口令。'); }
  return options;
}
class ConnectionProfiles {
  constructor({ dataDir, secretStorage } = {}) {
    this.file = path.join(dataDir, 'connections.json');
    this.secretStorage = secretStorage;
    this.records = [];
    this.writes = Promise.resolve();
  }
  secureAvailable() { return Boolean(this.secretStorage?.isEncryptionAvailable()); }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (!Array.isArray(data) || data.some(record => typeof record.id !== 'string')) throw new Error();
      this.records = data;
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('连接方案文件无法读取；为保留原始内容，已停止加载。'); }
  }
  list() {
    return this.records.map(({ encryptedSecrets, ...record }) => ({ ...record, compatibleEngines: PROTOCOLS[record.protocol]?.engines || [] }));
  }
  get(id) {
    const record = this.records.find(item => item.id === id);
    if (!record) throw new Error('找不到这个连接方案，请重新选择。');
    let secrets = {};
    if (record.encryptedSecrets) {
      if (!this.secureAvailable()) throw new Error('当前无法访问系统加密存储。');
      try { secrets = JSON.parse(this.secretStorage.decryptString(Buffer.from(record.encryptedSecrets, 'base64'))); }
      catch { throw new Error('无法解密此连接方案，请在当前 Windows 用户下重新填写 Key。'); }
    }
    return { profile: record, secrets };
  }
  async resolve(input) {
    const old = input?.id ? this.get(input.id) : { secrets: {} };
    const profile = validateProfile(input);
    const secrets = { ...old.secrets };
    for (const key of ['apiKey', 'clientKeyPassphrase']) {
      if (input[key] !== undefined && input[key] !== '') {
        if (typeof input[key] !== 'string' || input[key].length > 4096 || /[\0\r\n]/.test(input[key])) throw new Error('Key 或口令格式不正确。');
        secrets[key] = input[key];
      }
    }
    if (input.clearApiKey) delete secrets.apiKey;
    if (input.clearPassphrase) delete secrets.clientKeyPassphrase;
    if (profile.authMode !== 'none' && !secrets.apiKey) throw new Error('请填写 API Key；无需认证的本地服务可以选择“无认证”。');
    await tlsOptions(profile, secrets);
    return { profile, secrets };
  }
  async save(input) {
    const { profile, secrets } = await this.resolve(input);
    let encryptedSecrets;
    if (Object.values(secrets).some(Boolean)) {
      if (!this.secureAvailable()) throw new Error('系统加密存储不可用，无法保存 Key 或私钥口令。请使用 Electron 桌面版。');
      encryptedSecrets = this.secretStorage.encryptString(JSON.stringify(secrets)).toString('base64');
    }
    const record = { ...profile, id: input.id || crypto.randomUUID(), hasApiKey: Boolean(secrets.apiKey), hasPassphrase: Boolean(secrets.clientKeyPassphrase), ...(encryptedSecrets ? { encryptedSecrets } : {}) };
    return this.mutate(() => { this.records = [...this.records.filter(item => item.id !== record.id), record]; return record.id; });
  }
  async remove(id) {
    this.get(id);
    return this.mutate(() => { this.records = this.records.filter(item => item.id !== id); });
  }
  async mutate(operation) {
    const job = this.writes.catch(() => {}).then(async () => {
      const before = this.records;
      const result = operation();
      try {
        await fs.mkdir(path.dirname(this.file), { recursive: true });
        await fs.writeFile(`${this.file}.tmp`, JSON.stringify(this.records, null, 2), { mode: 0o600 });
        await fs.rename(`${this.file}.tmp`, this.file);
      } catch { this.records = before; throw new Error('连接方案保存失败，请检查应用数据目录。'); }
      return result;
    });
    this.writes = job;
    return job;
  }
}
module.exports = { ConnectionProfiles, PROTOCOLS, validateProfile, tlsOptions };
