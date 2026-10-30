const { tokens: mentionTokens } = require('../shared/mentions.cjs');
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
const { ContextTelemetry } = require('./context-telemetry.cjs');
const { CapabilityLibrary } = require('./capability-library.cjs');
const { McpHub } = require('./mcp-hub.cjs');
const { capabilityLaunch } = require('./capability-launch.cjs');

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
    directory: agent.directory, workspaceId: workspaceId(agent.directory), sessionId: agent.rpc?.backendSessionId || agent.session_id, headless: Boolean(agent.headless),
    unread: agent.unread_count || 0, mode: agent.mode || 'pty', rpc: agent.rpc,
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
  const mentioned = mentionTokens(text).map(token => token.name);
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
  const invalid = message => Object.assign(new Error(message), { code: 'invalid_message', outcome: 'rejected' });
  if (!payload || typeof payload.roomId !== 'string' || typeof payload.text !== 'string') throw invalid('消息格式不正确。');
  const text = payload.text.trim();
  if (!text) throw invalid('先写点什么吧。');
  if (text.length > 16000) throw invalid('消息太长，请控制在 16000 个字符以内。');
  if (text.includes('\0')) throw invalid('消息包含不支持的字符。');
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
    this.runtime = options.runtime;
    this.binary = this.runtime?.binary || options.binary || process.env.HCOM_BINARY || path.join(os.homedir(), '.local', 'bin', 'hcom.exe');
    this.run = options.run || ((args, timeout = 12000, scopedEnv = {}) => runFile(this.binary, args, {
      windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024,
      encoding: 'utf8', env: hcomEnvironment(process.env, this.commandPath, scopedEnv),
    }).then(result => result.stdout));
    this.rooms = [];
    this.removedAgents = new Map();
    this.workspaceDefinitions = [];
    this.state = { connection: 'connecting', error: '', agents: [], messages: [], rooms: [], workspaces: [], engines: [], version: '', updatedAt: null };
    this.saving = Promise.resolve();
    this.connections = new ConnectionProfiles({ dataDir: this.dataDir, secretStorage: options.secretStorage });
    this.gateways = new Set();
    this.sessionGateways = new Map();
    this.usage = new UsageLedger(this.dataDir);
    this.contexts = new ContextTelemetry({ dataDir: this.dataDir });
    this.library = new CapabilityLibrary({ dataDir: this.dataDir, secretStorage: options.secretStorage });
    this.mcpHub = new McpHub({ library: this.library });
    this.agentCapabilities = new Map();
    if (this.runtime) {
      this.state.runtimeMode = 'native';
      this.runtime.on('state', () => this.refresh());
      this.runtime.on('terminal', event => this.emit('terminal', event));
      this.runtime.on('session-exit', id => {
        const binding = this.agentCapabilities.get(id);
        if (binding) this.mcpHub.release(binding.scope).then(() => this.refresh());
        const gateway = this.sessionGateways.get(id);
        if (gateway) { gateway.close(); this.gateways.delete(gateway); this.sessionGateways.delete(id); }
        this.refresh();
      });
      this.runtime.on('failure', error => { this.state.connection = 'disconnected'; this.state.error = error.message; this.emit('state', this.snapshot()); });
    }
  }
  async start() {
    await fs.mkdir(this.dataDir, { recursive: true });
    try { this.removedAgents = new Map(JSON.parse(await fs.readFile(path.join(this.dataDir, 'removed-agents.json'), 'utf8')).map(item => typeof item === 'string' ? [item, null] : item)); } catch (error) { if (error.code !== 'ENOENT') throw new Error('已移除成员记录无法读取，请检查数据目录。'); }
    await this.usage.load();
    try { await this.library.load(); } catch { /* Preserve the unreadable registry and expose its error. */ }
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
    if (this.runtime) {
      try {
        const result = await this.runtime.start({ env: hcomEnvironment(process.env, `${path.dirname(this.binary)};${this.commandPath || process.env.PATH}`) });
        this.state.version = result.version;
        this.binary = this.runtime.binary;
      } catch (error) {
        this.state.connection = 'disconnected'; this.state.error = `原生运行核心无法启动：${error.message}。开发环境请运行 npm run build:native。`;
        this.emit('state', this.snapshot()); return this.snapshot();
      }
    } else {
      try { this.state.version = (await this.run(['--version'])).trim().replace(/^hcom\s+/, ''); } catch { }
    }
    await this.detectEngines();
    await this.refresh();
    if (!this.runtime) { this.timer = setInterval(() => this.refresh(), 2500); this.timer.unref(); }
    else { this.timer = setInterval(() => this.refresh(), 5000); this.timer.unref(); }
    return this.snapshot();
  }
  snapshot() {
    this.snapshotInstance ||= crypto.randomUUID();
    this.snapshotRevision = (this.snapshotRevision || 0) + 1;
    const defaults = this.state.workspaces.map(workspace => ({
      id: `lobby:${workspace.id}`, title: '协作大厅', thread: `agent-room-${workspace.id}`, workspaceId: workspace.id,
      type: 'group', allMembers: true, pinned: true, description: '想法在这里相遇，工作从这里开始。',
    }));
    const trial = this.state.workspaces.find(workspace => path.basename(workspace.directory) === 'hcom-trial');
    if (trial) defaults.push({ ...DEFAULT_ROOMS[1], workspaceId: trial.id });
    return structuredClone({ ...this.state, sync: { instanceId: this.snapshotInstance, revision: this.snapshotRevision }, rooms: [...defaults, ...this.rooms], connections: this.connections.list(),
      secureStorageAvailable: this.connections.secureAvailable(), activeGateways: this.gateways.size, activeSessions: this.runtime?.activeSessions || 0,
      capabilityLibrary: this.library.snapshot() });
  }
  async detectEngines() {
    if (this.runtime) {
      this.state.engines = (await this.runtime.engines()).map(engine => ({ ...engine, label: TOOL_LABELS[engine.id] })); return;
    }
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
        let roster, history;
        if (this.runtime) { const snapshot = await this.runtime.snapshot(); roster = snapshot.agents; history = snapshot.events; }
        else {
          const [a, b] = await Promise.all([this.run(['list', '--json']), this.run(['events', '--type', 'message', '--last', '500', '--full'])]);
          roster = JSON.parse(a); history = parseLines(b);
        }
        const rosterAgents = await Promise.all(roster.map(async raw => {
          const agent = cleanAgent(raw);
          agent.context = await this.contexts.observe(agent, raw.transcript_path);
          const binding = this.agentCapabilities.get(agent.id) || this.agentCapabilities.get(agent.name);
          if (binding && (!binding.sessionId || binding.sessionId === agent.sessionId)) {
            binding.sessionId ||= agent.sessionId;
            agent.capabilities = this.mcpHub.snapshot(binding.scope);
          }
          return agent;
        }));
        const agents = rosterAgents.filter(agent => !this.removedAgents.has(`${agent.id}:${agent.sessionId || ''}`));
        const archivedAgents = [...this.removedAgents].map(([key, saved]) => rosterAgents.find(a => `${a.id}:${a.sessionId || ''}` === key) || saved).filter(a => a && !agents.some(active => active.id === a.id));
        const workspaces = new Map(this.workspaceDefinitions.map(workspace => [workspace.id, workspace]));
        for (const agent of [...agents, ...archivedAgents]) if (!workspaces.has(agent.workspaceId)) workspaces.set(agent.workspaceId, {
          id: agent.workspaceId, title: path.basename(agent.directory) === 'hcom-trial' ? '我的工作区' : path.basename(agent.directory), directory: agent.directory,
        });
        if (!workspaces.size) {
          const directory = path.resolve(__dirname, '..');
          const id = workspaceId(directory);
          workspaces.set(id, { id, directory, title: '我的工作区' });
        }
        this.state = { ...this.state, connection: 'connected', error: '', agents, archivedAgents,
          workspaces: [...workspaces.values()], messages: normalizeMessages(history, [...agents, ...archivedAgents]), updatedAt: new Date().toISOString() };
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
  explicitRecipients(ids, room) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== 'string')) throw new Error('请选择有效接收者。');
    const allowed = this.state.agents.filter(a => a.workspaceId === room.workspaceId && (room.allMembers || room.members?.includes(a.id)));
    if (ids.some(id => !allowed.some(a => a.id === id))) throw new Error('接收者必须是当前房间成员。');
    return [...new Set(ids)];
  }
  async send(payload) {
    const text = validateMessage(payload);
    await this.refresh();
    let room, targets;
    try {
      if (this.state.connection !== 'connected') throw new Error('hcom 尚未连接，消息没有发送。');
      room = this.findRoom(payload.roomId);
      targets = payload.recipientIds === undefined ? resolveTargets(text, room, this.state.agents) : this.explicitRecipients(payload.recipientIds, room);
      if (!targets.length) throw new Error('房间里还没有已连接的 agent。');
    } catch (error) { throw Object.assign(error, { code: 'send_rejected', outcome: 'rejected' }); }
    const args = ['send', '--from', 'user', ...targets.map(name => `@${name}`), '--intent', 'request', '--thread', room.thread, '--json', '--', text];
    let receipt;
    try { receipt = this.runtime ? await this.runtime.send({ targets, text, thread: room.thread }) : JSON.parse(await this.run(args)); }
    catch (error) {
      // A process error may happen after hcom stored the message. Never retry a send.
      await this.refresh();
      throw Object.assign(new Error('发送结果未确认，请先检查消息记录，再决定是否重发。'), { code: 'send_unknown', outcome: 'unknown' });
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
    if (this.runtime) return { ...await this.runtime.terminal(id), agent, native: true };
    const output = parseLines(await this.run(['term', agent.id, '--json']));
    if (!output.length) throw new Error('该会话暂时没有可查看的终端画面。');
    return { ...output[0], agent };
  }
  async setRoomMembers(id, members) {
    const room = this.rooms.find(r => r.id === id);
    if (!room) throw Object.assign(new Error('默认大厅和私聊的成员由工作区管理。'), { code: 'immutable_room', outcome: 'rejected' });
    if (!members.length || members.some(id => !this.state.agents.some(a => a.id === id && a.workspaceId === room.workspaceId))) throw Object.assign(new Error('请选择同一工作区内的成员。'), { code: 'invalid_members', outcome: 'rejected' });
    this.saving = this.saving.catch(() => {}).then(async () => {
      const next = this.rooms.map(r => r.id === id ? { ...r, members: [...new Set(members)] } : r);
      const target = path.join(this.dataDir, 'rooms.json');
      await fs.writeFile(`${target}.tmp`, JSON.stringify(next, null, 2)); await fs.rename(`${target}.tmp`, target);
      this.rooms = next;
    });
    await this.saving; this.emit('state', this.snapshot());
  }
  async removeAgent(id) {
    const agent = this.state.agents.find(a => a.id === id);
    if (!agent) throw Object.assign(new Error('成员不存在。'), { code: 'not_found', outcome: 'rejected' });
    if (agent.status !== 'inactive') await this.stopSession(id);
    const key = `${agent.id}:${agent.sessionId || ''}`;
    this.saving = this.saving.catch(() => {}).then(async () => {
      const { id, name, displayName, tool, label, directory, workspaceId, sessionId } = agent;
      const next = new Map([...this.removedAgents, [key, { id, name, displayName, tool, label, directory, workspaceId, sessionId, status: 'inactive' }]]), target = path.join(this.dataDir, 'removed-agents.json');
      await fs.writeFile(`${target}.tmp`, JSON.stringify([...next])); await fs.rename(`${target}.tmp`, target);
      this.removedAgents = next;
    });
    await this.saving; await this.refresh();
  }
  async launch(payload) {
    if (!Object.hasOwn(TOOL_LABELS, payload?.tool)) throw new Error('请选择受支持的 agent。');
    if (typeof payload.directory !== 'string' || !path.isAbsolute(payload.directory)) throw new Error('请选择完整的工作目录路径。');
    if (!(await fs.stat(payload.directory)).isDirectory()) throw new Error('工作目录不存在。');
    const tag = typeof payload.tag === 'string' ? payload.tag.trim() : '';
    if (tag && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(tag)) throw new Error('Tag 只能包含字母、数字、短横线和下划线，最多 32 个字符。');
    if (this.library.error) throw new Error(this.library.error);
    const capabilityPlan = this.library.plan(workspaceId(payload.directory), payload.capabilities);
    const hasCapabilities = capabilityPlan.servers.length || capabilityPlan.skills.length;
    if (hasCapabilities && !['codex', 'claude', 'pi', 'opencode'].includes(payload.tool)) throw new Error('该引擎尚未适配统一能力库；请关闭本次能力分配或选择四种主要引擎。');
    // The compatibility CLI path (including browser preview) must also stay in
    // the background. windowsHide alone cannot hide terminals launched by hcom.
    const args = [payload.tool, '--headless', '--go', ...(tag ? ['--tag', tag] : []), '--dir', payload.directory, '--json'];
    let gateway, contextScope, capabilityConnection;
    let scopedEnv = {};
    if (payload.connectionId) {
      const { profile, secrets } = this.connections.get(payload.connectionId);
      contextScope = this.contexts.createScope(profile, payload.model);
      gateway = await startGateway(profile, secrets, { engine: payload.tool, model: payload.model || profile.model,
        onUsage: (metadata, usage) => {
          this.contexts.record(contextScope, metadata, usage);
          this.usage.record(metadata, usage).then(() => this.emit('usage', this.usage.snapshot()));
          this.refresh();
        } });
      try {
        const connection = await engineConnection(payload.tool, profile, gateway, this.dataDir, payload.model);
        args.push(...connection.args);
        scopedEnv = connection.env;
      } catch (error) { gateway.close(); throw error; }
      // Keep the bridge alive if launch times out: the agent may already exist.
      this.gateways.add(gateway);
    }
    if (payload.tool === 'pi') {
      try {
        const telemetry = await this.contexts.piExtension();
        args.push(...telemetry.args);
        Object.assign(scopedEnv, telemetry.env);
      } catch (error) { gateway?.close(); this.gateways.delete(gateway); throw error; }
    }
    if (hasCapabilities) {
      try {
        capabilityConnection = await this.mcpHub.session({ plan: capabilityPlan, directory: payload.directory, workspaceId: workspaceId(payload.directory) });
        const capability = await capabilityLaunch(payload.tool, capabilityConnection, this.dataDir, scopedEnv);
        args.push(...capability.args); Object.assign(scopedEnv, capability.env);
      } catch (error) {
        if (capabilityConnection) await this.mcpHub.release(capabilityConnection.scope);
        gateway?.close(); this.gateways.delete(gateway); throw error;
      }
    }
    let result;
    try {
      result = this.runtime ? await this.runtime.launch({ tool: payload.tool, directory: payload.directory, tag, args: args.slice(args.indexOf('--json') + 1), env: scopedEnv }) : JSON.parse(await this.run(args, 45000, scopedEnv));
    }
    catch (error) {
      if (error.outcomeKnown) {
        gateway?.close(); this.gateways.delete(gateway);
        if (capabilityConnection) await this.mcpHub.release(capabilityConnection.scope);
        await this.refresh(); throw error;
      }
      try { result = JSON.parse(error.stdout); } catch { throw new Error(this.runtime ? `原生会话启动失败：${error.message}。请检查成员列表后再决定是否重试。` : '后台启动结果未确认。请检查成员列表和会话终端，不要重复启动。'); }
    }
    if (gateway && this.runtime) for (const handle of result.handles || []) this.sessionGateways.set(handle.instance_name, gateway);
    if (capabilityConnection) for (const name of result.names || (result.handles || []).map(h => h.instance_name)) this.agentCapabilities.set(name, { scope: capabilityConnection.scope, sessionId: '' });
    await this.refresh();
    if (contextScope) {
      this.contexts.bind(contextScope, result.names || (result.handles || []).map(handle => handle.instance_name), this.state.agents);
      await this.refresh();
    }
    return { result, state: this.snapshot() };
  }
  async saveConnection(payload) {
    if (this.state.configurationError) throw new Error(this.state.configurationError);
    const id = await this.connections.save(payload);
    this.emit('state', this.snapshot());
    return { id, state: this.snapshot() };
  }
  async saveCapabilityServer(payload) { const id = await this.library.saveServer(payload); await this.mcpHub.reconcile(); await this.refresh(); return { id, state: this.snapshot() }; }
  async importCapabilitySkill(payload) { const id = await this.library.importSkill(payload); await this.refresh(); return { id, state: this.snapshot() }; }
  async removeCapability(payload) { await this.library.remove(payload?.kind, payload?.id); await this.mcpHub.reconcile(); await this.refresh(); return { state: this.snapshot() }; }
  async bindCapabilities(payload) {
    if (!this.state.workspaces.some(w => w.id === payload?.workspaceId)) throw new Error('请先添加或选择工作区。');
    await this.library.bind(payload); await this.refresh(); return { state: this.snapshot() };
  }
  async testCapabilityServer(payload) {
    const workspace = this.state.workspaces.find(w => w.id === payload?.workspaceId);
    if (!workspace) throw new Error('请先选择用于测试的工作区。');
    return this.mcpHub.test(payload.id, workspace.directory);
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
  terminalInput(id, data) { if (!this.runtime) throw new Error('仅应用托管的原生会话支持输入。'); return this.runtime.input(id, data); }
  terminalResize(id, cols, rows) { if (!this.runtime) throw new Error('仅应用托管的原生会话支持调整大小。'); return this.runtime.resize(id, cols, rows); }
  stopSession(id) { if (!this.runtime) throw new Error('仅支持停止本应用托管的会话。'); return this.runtime.stop(id); }
  inspectSession(id) { if (!this.runtime?.inspect) throw new Error('此会话不支持 RPC'); return this.runtime.inspect(id); }
  respondSession(id, requestId, answer) { if (!this.runtime?.respond) throw new Error('此会话不支持 RPC'); return this.runtime.respond(id, requestId, answer); }
  cancelSession(id, expectedTurnId) { if (!this.runtime?.cancel) throw new Error('此会话不支持 RPC'); return this.runtime.cancel(id, expectedTurnId); }
  async close() {
    clearInterval(this.timer);
    try { await this.runtime?.close(); } finally { await this.mcpHub.close(); for (const gateway of this.gateways) gateway.close(); this.gateways.clear(); }
  }
}
module.exports = { HcomService, cleanAgent, normalizeMessages, parseLines, resolveTargets, validateMessage, workspaceId, DEFAULT_ROOMS, hcomEnvironment };
