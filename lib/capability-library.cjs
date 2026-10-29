const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const idOK = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
function text(value, max = 4096) {
  if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value)) throw new Error('配置字段格式不正确。');
  return value;
}
function dictionary(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 100) throw new Error('环境变量和 Headers 必须为 JSON 对象。');
  const result = Object.create(null);
  for (const [key, v] of Object.entries(value)) { text(key, 200); result[key] = text(v, 8192); }
  return result;
}
function serverFields(input) {
  const name = text(input.name, 80).trim();
  if (!name || !['stdio', 'http', 'sse'].includes(input.transport)) throw new Error('请填写名称并选择 MCP 传输方式。');
  const result = { name, transport: input.transport, enabled: input.enabled !== false, isolation: input.isolation === 'workspace' ? 'workspace' : 'session' };
  if (input.transport === 'stdio') {
    result.command = text(input.command, 2048).trim();
    if (!result.command || !Array.isArray(input.args) || input.args.length > 100) throw new Error('请填写启动命令；参数必须为 JSON 数组。');
    result.args = input.args.map(arg => text(arg, 8192));
  } else {
    const url = new URL(text(input.url));
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('MCP URL 必须是无内嵌凭证的 HTTP(S) 地址。');
    result.url = url.href;
  }
  if (!Array.isArray(input.disabledTools || []) || (input.disabledTools || []).length > 1000) throw new Error('禁用工具列表格式错误。');
  result.disabledTools = [...new Set((input.disabledTools || []).map(name => text(name, 256)))];
  return result;
}

class CapabilityLibrary {
  constructor({ dataDir, secretStorage } = {}) {
    this.root = path.join(dataDir, 'capabilities'); this.file = path.join(this.root, 'library.json');
    this.secretStorage = secretStorage; this.data = { version: 1, servers: [], skills: [], bindings: [] }; this.writes = Promise.resolve(); this.error = '';
  }
  secureAvailable() { try { return Boolean(this.secretStorage?.isEncryptionAvailable()); } catch { return false; } }
  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      if (data.version !== 1 || !['servers', 'skills', 'bindings'].every(key => Array.isArray(data[key]))) throw new Error();
      for (const server of data.servers) { if (!idOK(server.id)) throw new Error(); serverFields(server); }
      for (const skill of data.skills) if (!idOK(skill.id) || !/^[a-f0-9]{64}$/.test(skill.hash)) throw new Error();
      for (const binding of data.bindings) if (!/^[a-f0-9]{12}$/.test(binding.workspaceId) || !['serverIds', 'skillIds'].every(key => Array.isArray(binding[key]) && binding[key].every(idOK))) throw new Error();
      this.data = data;
    } catch (e) { if (e.code !== 'ENOENT') { this.error = '能力库文件无法读取，已保留原文件并停止写入。'; throw new Error(this.error); } }
  }
  snapshot() {
    return { ...structuredClone(this.data), servers: this.data.servers.map(({ encryptedSecrets, ...server }) => ({ ...server })), skills: this.data.skills.map(({ manifest, ...skill }) => ({ ...skill })), secureStorageAvailable: this.secureAvailable(), error: this.error };
  }
  mutate(operation) {
    const job = this.writes.catch(() => {}).then(async () => {
      if (this.error) throw new Error(this.error);
      const before = structuredClone(this.data);
      try {
        const result = await operation();
        await fs.mkdir(this.root, { recursive: true });
        await fs.writeFile(`${this.file}.tmp`, JSON.stringify(this.data, null, 2), { mode: 0o600 });
        await fs.rename(`${this.file}.tmp`, this.file);
        return result;
      } catch (e) { this.data = before; throw e; }
    });
    this.writes = job; return job;
  }
  secrets(server) {
    if (!server.encryptedSecrets) return {};
    if (!this.secureAvailable()) throw new Error('系统加密存储不可用，请在桌面版中重新保存 MCP 凭证。');
    try { return JSON.parse(this.secretStorage.decryptString(Buffer.from(server.encryptedSecrets, 'base64'))); }
    catch { throw new Error('MCP 凭证无法解密。'); }
  }
  saveServer(input) {
    return this.mutate(() => {
      const old = input.id ? this.data.servers.find(server => server.id === input.id) : null;
      if (input.id && !old) throw new Error('找不到该 MCP 服务。');
      const fields = serverFields(input);
      const secrets = this.secrets(old || {});
      for (const key of ['env', 'headers']) {
        if (input[key] !== undefined) secrets[key] = dictionary(input[key]);
        if (input[`clear${key === 'env' ? 'Env' : 'Headers'}`]) delete secrets[key];
      }
      let encryptedSecrets;
      if (Object.values(secrets).some(v => Object.keys(v).length)) {
        if (!this.secureAvailable()) throw new Error('系统加密存储不可用；含环境变量或 Headers 的服务请在桌面版保存。');
        encryptedSecrets = this.secretStorage.encryptString(JSON.stringify(secrets)).toString('base64');
      }
      const record = { ...fields, id: old?.id || crypto.randomUUID(), revision: (old?.revision || 0) + 1,
        envKeys: Object.keys(secrets.env || {}), headerKeys: Object.keys(secrets.headers || {}), ...(encryptedSecrets ? { encryptedSecrets } : {}) };
      this.data.servers = [...this.data.servers.filter(server => server.id !== record.id), record];
      return record.id;
    });
  }
  importSkill(input) {
    return this.mutate(async () => {
      if (typeof input?.directory !== 'string' || !path.isAbsolute(input.directory)) throw new Error('请选择包含 SKILL.md 的完整目录。');
      const old = input.id ? this.data.skills.find(skill => skill.id === input.id) : null;
      if (input.id && !old) throw new Error('找不到该 Skill。');
      const source = path.resolve(input.directory), files = [];
      let bytes = 0;
      const walk = async (directory, relative = '') => {
        const stat = await fs.lstat(directory);
        if (stat.isSymbolicLink()) throw new Error('Skill 目录不能包含符号链接或目录联接。');
        if (stat.isDirectory()) {
          for (const name of (await fs.readdir(directory)).sort()) {
            if (['.git', 'node_modules', '.DS_Store'].includes(name)) continue;
            await walk(path.join(directory, name), path.join(relative, name));
          }
        } else if (stat.isFile()) {
          if (stat.size > 16 * 1024 * 1024 || bytes + stat.size > 64 * 1024 * 1024 || files.length >= 2000) throw new Error('Skill 超过导入限制：2000 个文件或 64 MiB。');
          const content = await fs.readFile(directory); bytes += content.length; files.push({ relative, content });
        } else throw new Error('Skill 包含不支持的文件类型。');
      };
      await walk(source);
      const md = files.find(file => file.relative === 'SKILL.md');
      if (!md || md.content.length > 256 * 1024) throw new Error('目录需要包含不超过 256 KiB 的 SKILL.md。');
      const content = md.content.toString('utf8');
      const meta = key => content.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim().replace(/^['"]|['"]$/g, '') || '';
      const name = input.name?.trim() || meta('name') || path.basename(source);
      if (!name || name.length > 120) throw new Error('Skill 名称过长。');
      const digest = crypto.createHash('sha256');
      for (const file of files) digest.update(file.relative.replaceAll('\\', '/')).update('\0').update(file.content).update('\0');
      const hash = digest.digest('hex'), id = old?.id || crypto.randomUUID();
      const target = this.skillPath({ id, hash });
      await fs.mkdir(target, { recursive: true });
      // Content-addressed snapshots never overwrite a session's pinned version.
      for (const file of files) {
        const dest = path.join(target, file.relative); await fs.mkdir(path.dirname(dest), { recursive: true });
        try { await fs.writeFile(dest, file.content, { flag: 'wx', mode: 0o600 }); } catch (e) {
          if (e.code !== 'EEXIST') throw e;
          if (!(await fs.readFile(dest)).equals(file.content)) throw new Error('已有 Skill 快照发生外部修改，已保留原文件并停止更新。');
        }
      }
      const manifest = Object.fromEntries(files.map(file => [file.relative.replaceAll('\\', '/'), crypto.createHash('sha256').update(file.content).digest('hex')]));
      const skill = { id, name, description: meta('description').slice(0, 1000), hash, source, manifest, revision: (old?.revision || 0) + 1, files: files.length, bytes, importedAt: new Date().toISOString() };
      this.data.skills = [...this.data.skills.filter(skill => skill.id !== id), skill]; return id;
    });
  }
  skillPath(skill) {
    if (!idOK(skill.id) || !/^[a-f0-9]{64}$/.test(skill.hash)) throw new Error('Skill 版本无效。');
    return path.join(this.root, 'skills', skill.id, skill.hash);
  }
  remove(kind, id) {
    return this.mutate(() => {
      if (!['servers', 'skills'].includes(kind)) throw new Error('能力类型无效。');
      this.data[kind] = this.data[kind].filter(item => item.id !== id);
      const key = kind === 'servers' ? 'serverIds' : 'skillIds';
      for (const binding of this.data.bindings) binding[key] = binding[key].filter(value => value !== id);
      // Old skill snapshots remain available to already-running sessions.
    });
  }
  selection(input) {
    const result = {};
    for (const [key, collection] of [['serverIds', 'servers'], ['skillIds', 'skills']]) {
      if (!Array.isArray(input?.[key]) || input[key].some(id => !this.data[collection].some(item => item.id === id))) throw new Error('选择的能力已不存在，请刷新后重试。');
      result[key] = [...new Set(input[key])];
    }
    return result;
  }
  bind(input) {
    return this.mutate(() => {
      if (typeof input.workspaceId !== 'string' || !/^[a-f0-9]{12}$/.test(input.workspaceId)) throw new Error('工作区无效。');
      const binding = { workspaceId: input.workspaceId, ...this.selection(input) };
      this.data.bindings = [...this.data.bindings.filter(b => b.workspaceId !== input.workspaceId), binding];
    });
  }
  plan(workspaceId, selection) {
    const chosen = selection?.mode === 'off' ? { serverIds: [], skillIds: [] } : selection?.mode === 'custom' ? this.selection(selection)
      : this.data.bindings.find(b => b.workspaceId === workspaceId) || { serverIds: [], skillIds: [] };
    return { servers: structuredClone(this.data.servers.filter(s => s.enabled && chosen.serverIds.includes(s.id))), skills: structuredClone(this.data.skills.filter(s => chosen.skillIds.includes(s.id))) };
  }
}
module.exports = { CapabilityLibrary, serverFields };
