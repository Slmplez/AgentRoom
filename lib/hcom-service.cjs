const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const runFile = promisify(execFile);
const { ConnectionProfiles } = require('./connection-profiles.cjs');
const { inspectModels, startGateway } = require('./model-gateway.cjs');
const { engineConnection } = require('./engine-connections.cjs');
const { UsageLedger } = require('./usage.cjs');

const TOOL_LABELS = {
  codex: 'Codex', claude: 'Claude Code', pi: 'Pi', opencode: 'OpenCode', gemini: 'Gemini CLI',
  omp: 'Oh My Pi', kilo: 'Kilo Code', hermes: 'Hermes', antigravity: 'Antigravity',
  cursor: 'Cursor CLI', kimi: 'Kimi', copilot: 'Copilot CLI', qoder: 'Qoder', grok: 'Grok Build',
};
function workspaceId(directory) {
  const normalized = path.resolve(directory).replace(/[\\/]+$/, '').toLowerCase();
  return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}
const DEFAULT_ROOMS = [
  { id: 'lobby', title: '协作大厅', thread: 'agent-room', type: 'group', allMembers: true, pinned: true, description: '想法在这里相遇，工作从这里开始。' },
  { id: 'hcom-trial', title: 'hcom 体验记录', thread: 'hcom-trial', type: 'group', allMembers: true, pinned: false, description: '之前的消息与连接验证记录' },
];

function parseLines(output) {
  return output.split(/\r?\n/).filter(line => line.trim().startsWith('{')).map(line => JSON.parse(line));
}
function cleanAgent(agent) {
  const base = agent.base_name || agent.name;
  return {
    id: base, name: agent.name, baseName: base, tag: agent.tag || '', tool: agent.tool,
    label: TOOL_LABELS[agent.tool] || agent.tool,
    displayName: `${TOOL_LABELS[agent.tool] || agent.tool} · ${base[0]?.toUpperCase() || ''}${base.slice(1)}`,
    status: agent.status, statusDetail: agent.status_detail || '', statusContext: agent.status_context || '',
    hooksBound: Boolean(agent.hooks_bound), processBound: Boolean(agent.process_bound),
    directory: agent.directory, workspaceId: workspaceId(agent.directory), sessionId: agent.session_id, headless: Boolean(agent.headless),
    unread: agent.unread_count || 0,
  };
}
function normalizeMessages(events, agents) {
  const byId = new Map(events.map(event => [String(event.id), event]));
  const agentById = new Map(agents.flatMap(agent => [[agent.id, agent], [agent.name, agent]]));
  function inheritedThread(event, visited = new Set()) {
    if (!event || visited.has(String(event.id))) return null;
    if (event.data.thread) return event.data.thread;
    visited.add(String(event.id));
    return inheritedThread(byId.get(String(event.data.reply_to_local || event.data.reply_to)), visited);
  }
  return events.filter(event => event.type === 'message' && event.data?.sender_kind !== 'system')
    .map(event => {
      const data = event.data;
      const agent = agentById.get(data.from);
      const human = data.sender_kind === 'external';
      return {
        id: String(event.id), sender: data.from, senderName: agent?.displayName || (human ? '你' : data.from),
        tool: agent?.tool || (human ? 'human' : 'agent'), human,
        text: data.text || '', timestamp: event.ts, thread: inheritedThread(event),
        recipients: data.mentions || [], deliveredTo: data.delivered_to || [],
        intent: data.intent || 'inform', replyTo: String(data.reply_to_local || data.reply_to || ''),
      };
    }).sort((a, b) => Number(a.id) - Number(b.id));
}
function resolveTargets(text, room, agents) {
  const workspaceAgents = room.workspaceId ? agents.filter(agent => agent.workspaceId === room.workspaceId) : agents;
  const allowedAgents = room.allMembers ? workspaceAgents : workspaceAgents.filter(agent => room.members?.includes(agent.id));
  const mentioned = [...text.matchAll(/(?:^|\s)@([a-zA-Z0-9][a-zA-Z0-9_-]*)/g)].map(match => match[1]);
  if (mentioned.length) {
    return [...new Set(mentioned.flatMap(name => {
      const matches = allowedAgents.filter(agent => agent.name === name || agent.baseName === name);
      if (matches.length === 1) return [matches[0].id];
      const tagged = allowedAgents.filter(agent => agent.tag && (agent.tag === name || `${agent.tag}-` === name));
      if (tagged.length) return tagged.map(agent => agent.id);
      throw new Error(`没有找到房间成员或标签 @${name}。请从提及列表中选择。`);
    }))];
  }
  return allowedAgents.map(agent => agent.id);
}
function validateMessage(payload) {
  if (!payload || typeof payload.roomId !== 'string' || typeof payload.text !== 'string') throw new Error('消息格式不正确。');
  const text = payload.text.trim();
  if (!text) throw new Error('先写点什么吧。');
  if (text.length > 16000) throw new Error('消息太长，请控制在 16000 个字符以内。');
  if (text.includes('\0')) throw new Error('消息包含不支持的字符。');
  return text;
}

function hcomEnvironment(parent, commandPath, scoped = {}) {
  const inheritedPath = Object.entries(parent).find(([key]) => key.toUpperCase() === 'PATH')?.[1];
  const env = { ...parent, TERM: 'xterm-256color' };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key];
  env.PATH = commandPath || inheritedPath || '';
  // hcom rebuilds the shell environment when it detects an enclosing agent/CI.
  // This app is the human launcher; remove identity markers so session overrides survive.
  const markers = new Set(['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_INTERNAL_ORIGINATOR_OVERRIDE', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_PROJECT_DIR',
    'GEMINI_CLI', 'GEMINI_CLI_IDE_SERVER_PORT', 'ANTIGRAVITY_AGENT', 'OPENCODE', 'OPENCODE_CLIENT', 'KILO', 'CURSOR_AGENT', 'CURSOR_TRACE_ID',
    'KIMI_CLI', 'QODER_CLI', 'GROK_CLI', 'PI_AGENT', 'PI_SESSION_ID', 'OMP_SESSION_ID', 'HERMES_SESSION_ID', 'HERMES_AGENT', 'CI', 'GITHUB_ACTIONS']);
  for (const key of Object.keys(env)) if (markers.has(key.toUpperCase()) || /^CARGO_|^HCOM_(?:TOOL|LAUNCHED|PROCESS_ID|SESSION_ID|PTY_MODE|BACKGROUND|INSTANCE_NAME)/i.test(key)) delete env[key];
  for (const [key, value] of Object.entries(scoped)) {
    for (const existing of Object.keys(env)) if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
    env[key] = value;
  }
  return env;
}

class HcomService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.dataDir = options.dataDir || path.join(__dirname, '..', '.data');
    this.binary = options.binary || process.env.HCOM_BINARY || path.join(os.homedir(), '.local', 'bin', 'hcom.exe');
    this.run = options.run || ((args, timeout = 12000, scopedEnv = {}) => runFile(this.binary, args, {
      windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8', env: hcomEnvironment(process.env, this.commandPath, scopedEnv),
    }).then(result => result.stdout));
    this.rooms = [];
    this.workspaceDefinitions = [];
    this.state = { connection: 'connecting', error: '', agents: [], messages: [], rooms: [], workspaces: [], engines: [], version: '', updatedAt: null };
    this.saving = Promise.resolve();
    this.connections = new ConnectionProfiles({ dataDir: this.dataDir, secretStorage: options.secretStorage });
    this.gateways = new Set();
    this.usage = new UsageLedger(this.dataDir);
  }
  async start() {
    await fs.mkdir(this.dataDir, { recursive: true });
    await this.usage.load();
    try { await this.connections.load(); } catch (error) { this.state.configurationError = error.message; }
    try {
      const saved = JSON.parse(await fs.readFile(path.join(this.dataDir, 'rooms.json'), 'utf8'));
      if (Array.isArray(saved)) this.rooms = saved.filter(room => typeof room.id === 'string' && typeof room.thread === 'string');
    } catch (error) { if (error.code !== 'ENOENT') this.emit('warning', '本地会话配置无法读取，已恢复默认列表。'); }
    try { this.workspaceDefinitions = JSON.parse(await fs.readFile(path.join(this.dataDir, 'workspaces.json'), 'utf8')); } catch { }
    if (process.platform === 'win32') {
      try {
        const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-Command', "(Get-AppxPackage -Name OpenAI.Codex | Sort-Object Version -Descending | Select-Object -First 1).InstallLocation"], { windowsHide: true, timeout: 8000 });
        const install = stdout.trim();
        if (install) {
          const resources = path.join(install, 'app', 'resources');
          await fs.access(path.join(resources, 'codex.exe'));
          this.commandPath = `${resources};${path.dirname(this.binary)};${process.env.PATH}`;
        }
      } catch { /* The regular CLI remains available when no desktop package exists. */ }
    }
    try { this.state.version = (await this.run(['--version'])).trim().replace(/^hcom\s+/, ''); } catch { }
    await this.detectEngines();
    await this.refresh();
    this.timer = setInterval(() => this.refresh(), 2500);
    this.timer.unref();
    return this.snapshot();
  }
  snapshot() {
    const defaults = this.state.workspaces.map(workspace => ({
      id: `lobby:${workspace.id}`, title: '协作大厅', thread: `agent-room-${workspace.id}`, workspaceId: workspace.id,
      type: 'group', allMembers: true, pinned: true, description: '想法在这里相遇，工作从这里开始。',
    }));
    const trial = this.state.workspaces.find(workspace => path.basename(workspace.directory) === 'hcom-trial');
    if (trial) defaults.push({ ...DEFAULT_ROOMS[1], workspaceId: trial.id });
    return structuredClone({ ...this.state, rooms: [...defaults, ...this.rooms], connections: this.connections.list(),
      secureStorageAvailable: this.connections.secureAvailable(), activeGateways: this.gateways.size });
  }
  async detectEngines() {
    try {
      const status = JSON.parse(await this.run(['status', '--json']));
      this.state.engines = Object.entries(TOOL_LABELS).map(([id, label]) => ({ id, label,
        installed: Boolean(status.tools?.[id]?.installed), hookMode: status.tools?.[id]?.hook_mode || 'unknown' }));
    } catch {
      this.state.engines = Object.entries(TOOL_LABELS).map(([id, label]) => ({ id, label, installed: false, hookMode: 'unknown' }));
    }
  }
  async rescan() { await this.detectEngines(); return this.refresh(); }
  async refresh() {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const [roster, history] = await Promise.all([
          this.run(['list', '--json']), this.run(['events', '--type', 'message', '--last', '500', '--full']),
        ]);
        const agents = JSON.parse(roster).map(cleanAgent);
        const workspaces = new Map(this.workspaceDefinitions.map(workspace => [workspace.id, workspace]));
        for (const agent of agents) if (!workspaces.has(agent.workspaceId)) workspaces.set(agent.workspaceId, {
          id: agent.workspaceId, title: path.basename(agent.directory) === 'hcom-trial' ? '我的工作区' : path.basename(agent.directory), directory: agent.directory,
        });
        if (!workspaces.size) {
          const directory = path.resolve(__dirname, '..');
          const id = workspaceId(directory);
          workspaces.set(id, { id, directory, title: '我的工作区' });
        }
        this.state = { ...this.state, connection: 'connected', error: '', agents,
          workspaces: [...workspaces.values()], messages: normalizeMessages(parseLines(history), agents), updatedAt: new Date().toISOString() };
      } catch (error) {
        this.state = { ...this.state, connection: 'disconnected', error: error.code === 'ENOENT' ? '未找到 hcom，请先安装或设置 HCOM_BINARY。' : '暂时无法连接 hcom，请检查本机服务。' };
      }
      this.emit('state', this.snapshot());
      return this.snapshot();
    })();
    try { return await this.refreshing; } finally { this.refreshing = null; }
  }
  findRoom(id) {
    const room = this.snapshot().rooms.find(room => room.id === id);
    if (room) return room;
    if (id.startsWith('dm:')) {
      const agent = this.state.agents.find(agent => agent.id === id.slice(3));
      if (agent) return { id, title: agent.displayName, thread: `agent-room-dm-${agent.id}`, type: 'dm', members: [agent.id], workspaceId: agent.workspaceId };
    }
    throw new Error('找不到这个会话。');
  }
  async send(payload) {
    const text = validateMessage(payload);
    await this.refresh();
    if (this.state.connection !== 'connected') throw new Error('hcom 尚未连接，消息没有发送。');
    const room = this.findRoom(payload.roomId);
    const targets = resolveTargets(text, room, this.state.agents);
    if (!targets.length) throw new Error('房间里还没有已连接的 agent。');
    const args = ['send', '--from', 'user', ...targets.map(name => `@${name}`), '--intent', 'request', '--thread', room.thread, '--json', '--', text];
    let receipt;
    try { receipt = JSON.parse(await this.run(args)); }
    catch (error) {
      // A process error may happen after hcom stored the message. Never retry a send.
      await this.refresh();
      throw new Error('发送结果未确认，请先检查消息记录，再决定是否重发。');
    }
    await this.refresh();
    return { receipt, targets, state: this.snapshot() };
  }
  async createRoom(payload) {
    const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
    if (!title || title.length > 40) throw new Error('房间名称应为 1–40 个字符。');
    const members = [...new Set(Array.isArray(payload.members) ? payload.members : [])];
    const workspace = this.state.workspaces.find(workspace => workspace.id === payload.workspaceId);
    if (!workspace) throw new Error('请先选择工作区。');
    if (!members.length || members.some(id => !this.state.agents.some(agent => agent.id === id && agent.workspaceId === workspace.id))) throw new Error('请至少选择一位当前工作区的成员。');
    const id = crypto.randomUUID();
    const room = { id, title, thread: `room-${id}`, members, workspaceId: workspace.id, type: 'group', pinned: false, description: '属于这个小队的协作空间' };
    this.rooms.push(room);
    this.saving = this.saving.catch(() => {}).then(async () => {
      const target = path.join(this.dataDir, 'rooms.json');
      await fs.writeFile(`${target}.tmp`, JSON.stringify(this.rooms, null, 2), 'utf8');
      await fs.rename(`${target}.tmp`, target);
    });
    await this.saving;
    this.emit('state', this.snapshot());
    return { room, state: this.snapshot() };
  }
  async terminal(id) {
    const agent = this.state.agents.find(agent => agent.id === id);
    if (!agent) throw new Error('该 agent 已离线。');
    const output = parseLines(await this.run(['term', agent.id, '--json']));
    if (!output.length) throw new Error('该会话暂时没有可查看的终端画面。');
    return { ...output[0], agent };
  }
  async launch(payload) {
    if (!Object.hasOwn(TOOL_LABELS, payload?.tool)) throw new Error('请选择受支持的 agent。');
    if (typeof payload.directory !== 'string' || !path.isAbsolute(payload.directory)) throw new Error('请选择完整的工作目录路径。');
    if (!(await fs.stat(payload.directory)).isDirectory()) throw new Error('工作目录不存在。');
    const tag = typeof payload.tag === 'string' ? payload.tag.trim() : '';
    if (tag && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(tag)) throw new Error('Tag 只能包含字母、数字、短横线和下划线，最多 32 个字符。');
    const args = [payload.tool, '--go', ...(tag ? ['--tag', tag] : []), '--dir', payload.directory, '--json'];
    let gateway;
    let scopedEnv = {};
    if (payload.connectionId) {
      const { profile, secrets } = this.connections.get(payload.connectionId);
      gateway = await startGateway(profile, secrets, { engine: payload.tool, model: payload.model || profile.model,
        onUsage: (metadata, usage) => { this.usage.record(metadata, usage).then(() => this.emit('usage', this.usage.snapshot())); } });
      try {
        const connection = await engineConnection(payload.tool, profile, gateway, this.dataDir, payload.model);
        args.push(...connection.args);
        scopedEnv = connection.env;
      } catch (error) { gateway.close(); throw error; }
      // Keep the bridge alive if launch times out: the agent may already exist.
      this.gateways.add(gateway);
    }
    let result;
    try { result = JSON.parse(await this.run(args, 45000, scopedEnv)); }
    catch (error) {
      try { result = JSON.parse(error.stdout); } catch { throw new Error('启动结果未确认。请检查成员列表和新终端，不要重复启动。'); }
    }
    await this.refresh();
    return { result, state: this.snapshot() };
  }
  async saveConnection(payload) {
    if (this.state.configurationError) throw new Error(this.state.configurationError);
    const id = await this.connections.save(payload);
    this.emit('state', this.snapshot());
    return { id, state: this.snapshot() };
  }
  async removeConnection(id) {
    await this.connections.remove(id);
    this.emit('state', this.snapshot());
    return this.snapshot();
  }
  async testConnection(payload) {
    const { profile, secrets } = await this.connections.resolve(payload);
    return inspectModels(profile, secrets);
  }
  async createWorkspace(payload) {
    const directory = typeof payload?.directory === 'string' ? payload.directory.trim() : '';
    const title = typeof payload?.title === 'string' ? payload.title.trim() : '';
    if (!path.isAbsolute(directory) || !(await fs.stat(directory)).isDirectory()) throw new Error('请选择存在的完整工作目录。');
    if (!title || title.length > 40) throw new Error('请输入 1–40 字的工作区名称。');
    const workspace = { id: workspaceId(directory), directory, title };
    this.workspaceDefinitions = [...this.workspaceDefinitions.filter(item => item.id !== workspace.id), workspace];
    await fs.writeFile(path.join(this.dataDir, 'workspaces.json'), JSON.stringify(this.workspaceDefinitions, null, 2), 'utf8');
    await this.refresh();
    return { workspace, state: this.snapshot() };
  }
  close() { clearInterval(this.timer); for (const gateway of this.gateways) gateway.close(); this.gateways.clear(); }
}
module.exports = { HcomService, cleanAgent, normalizeMessages, parseLines, resolveTargets, validateMessage, workspaceId, DEFAULT_ROOMS, hcomEnvironment };
