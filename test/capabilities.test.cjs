const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { pathToFileURL } = require('node:url');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { CapabilityLibrary } = require('../lib/capability-library.cjs');
const { McpHub } = require('../lib/mcp-hub.cjs');
const { capabilityLaunch } = require('../lib/capability-launch.cjs');
const { HcomService, workspaceId } = require('../lib/hcom-service.cjs');
const fixtureServer = path.resolve(__dirname, 'fixtures/mcp-server.cjs');
const secretStorage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(`test:${s}`), decryptString: b => b.toString().slice(5) };
const result = value => JSON.parse(value.content[0].text);
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ar-capability-'));
  const library = new CapabilityLibrary({ dataDir: directory, secretStorage }); await library.load();
  const hub = new McpHub({ library });
  const clients = [];
  t.after(async () => { await Promise.allSettled(clients.map(c => c.close())); await hub.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const save = extra => library.saveServer({ name: 'Test MCP', transport: 'stdio', command: process.execPath, args: [fixtureServer], ...extra });
  const connect = async (plan, cwd = directory, workspace = 'workspace-a') => {
    const connection = await hub.session({ plan, directory: cwd, workspaceId: workspace });
    const client = new Client({ name: 'test-agent', version: '1' }); clients.push(client);
    await client.connect(new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: { Authorization: `Bearer ${connection.token}` } }, reconnectionOptions: { maxRetries: 0 } }));
    return { ...connection, client };
  };
  return { directory, library, hub, save, connect };
}
async function skillSource(directory, content = 'Version one') {
  const source = path.join(directory, 'source'); await fs.mkdir(source, { recursive: true });
  await fs.writeFile(path.join(source, 'SKILL.md'), `---\nname: Review skill\ndescription: Review a workspace carefully\n---\n${content}\n`);
  await fs.writeFile(path.join(source, 'helper.txt'), 'Supporting resource'); return source;
}

test('registry serializes concurrent writes, encrypts sensitive maps and never returns secret values', async t => {
  const { library, save } = await fixture(t);
  await Promise.all([save({ name: 'One', env: { API_KEY: 'PRIVATE-ENV' } }), save({ name: 'Two', headers: { Authorization: 'PRIVATE-HEADER' } })]);
  assert.equal(library.data.servers.length, 2);
  const saved = await fs.readFile(library.file, 'utf8'), publicState = JSON.stringify(library.snapshot());
  assert.ok(!saved.includes('PRIVATE-')); assert.ok(!publicState.includes('PRIVATE-')); assert.ok(!publicState.includes('encryptedSecrets'));
  const one = library.snapshot().servers.find(s => s.name === 'One');
  await library.saveServer({ ...one, name: 'Renamed' });
  assert.equal(library.secrets(library.data.servers.find(s => s.id === one.id)).env.API_KEY, 'PRIVATE-ENV');
  const loaded = new CapabilityLibrary({ dataDir: path.dirname(library.root), secretStorage }); await loaded.load(); assert.equal(loaded.data.servers.length, 2);
});

test('damaged registry is preserved and locked; unknown selection and invalid URLs are rejected', async t => {
  const { directory, library, save } = await fixture(t);
  await assert.rejects(save({ transport: 'http', url: 'https://user:secret@example.com/mcp' }));
  assert.throws(() => library.plan('workspace', { mode: 'custom', serverIds: ['missing'], skillIds: [] }));
  await fs.mkdir(library.root, { recursive: true }); await fs.writeFile(library.file, '{damaged');
  const broken = new CapabilityLibrary({ dataDir: directory }); await assert.rejects(broken.load());
  await assert.rejects(broken.saveServer({ name: 'x', transport: 'stdio', command: 'node', args: [] }));
  assert.equal(await fs.readFile(library.file, 'utf8'), '{damaged');
});

test('Skill imports include resources, reject links, keep immutable versions and leave source files intact', async t => {
  const { directory, library } = await fixture(t), source = await skillSource(directory);
  const id = await library.importSkill({ directory: source }); const old = structuredClone(library.data.skills[0]);
  assert.equal(await fs.readFile(path.join(library.skillPath(old), 'helper.txt'), 'utf8'), 'Supporting resource');
  await fs.writeFile(path.join(source, 'SKILL.md'), 'Version two'); await library.importSkill({ id, directory: source });
  assert.notEqual(library.data.skills[0].hash, old.hash);
  assert.ok((await fs.readFile(path.join(library.skillPath(old), 'SKILL.md'), 'utf8')).includes('Version one'));
  await library.remove('skills', id); assert.equal(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8'), 'Version two');
  const linked = path.join(directory, 'linked'); await fs.symlink(source, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(library.importSkill({ directory: linked }), /链接|联接/);
});

test('real MCP HTTP session authenticates clients, namespaces tools without collisions and rejects other sessions', async t => {
  const { library, hub, save, connect } = await fixture(t); await save();
  const plan = { servers: library.data.servers, skills: [] }, connection = await connect(plan);
  const tools = (await connection.client.listTools()).tools;
  assert.equal(tools.length, 4); assert.equal(new Set(tools.map(t => t.name)).size, 4); assert.ok(tools.every(t => t.name.length <= 64));
  const echo = tools.find(t => t.description.includes('echo_workspace'));
  assert.equal(result(await connection.client.callTool({ name: echo.name, arguments: { text: 'hello' } })).text, 'hello');
  const denied = await fetch(connection.url, { method: 'POST', body: '{}' }); assert.equal(denied.status, 403);
  const origin = await fetch(connection.url, { method: 'POST', headers: { authorization: `Bearer ${connection.token}`, origin: 'https://example.com' }, body: '{}' }); assert.equal(origin.status, 403);
  await hub.release(connection.scope);
  const stopped = await fetch(connection.url, { method: 'POST', headers: { authorization: `Bearer ${connection.token}` }, body: '{}' }); assert.equal(stopped.status, 403);
});

test('workers isolate Agent sessions and workspaces; explicitly shared workers reuse one process with reference counting', async t => {
  const { directory, library, hub, save, connect } = await fixture(t);
  await save(); const plan = { servers: structuredClone(library.data.servers), skills: [] };
  const a = await connect(plan), b = await connect(plan);
  const read = async c => { const tool = (await c.client.listTools()).tools.find(t => t.description.includes('echo_workspace')); return result(await c.client.callTool({ name: tool.name })); };
  assert.notEqual((await read(a)).pid, (await read(b)).pid);
  const id = library.data.servers[0].id; await save({ id, isolation: 'workspace' });
  const sharedPlan = { servers: structuredClone(library.data.servers), skills: [] };
  const c = await connect(sharedPlan), d = await connect(sharedPlan), e = await connect(sharedPlan, directory, 'workspace-b');
  const cpid = (await read(c)).pid; assert.equal((await read(d)).pid, cpid); assert.notEqual((await read(e)).pid, cpid);
  await hub.release(c.scope); assert.equal((await read(d)).pid, cpid);
  await hub.release(d.scope); assert.throws(() => process.kill(cpid, 0));
});

test('global tool disables affect existing sessions and direct calls; disabling service closes its owned process', async t => {
  const { library, hub, save, connect } = await fixture(t); const id = await save();
  const c = await connect({ servers: structuredClone(library.data.servers), skills: [] });
  const tools = (await c.client.listTools()).tools, write = tools.find(t => t.description.includes('write_counter'));
  const pid = result(await c.client.callTool({ name: write.name })).pid;
  await save({ id, disabledTools: ['write_counter'] });
  assert.ok(!(await c.client.listTools()).tools.some(t => t.name === write.name));
  await assert.rejects(c.client.callTool({ name: write.name }));
  await save({ id, enabled: false }); await hub.reconcile();
  assert.equal((await c.client.listTools()).tools.length, 0); assert.throws(() => process.kill(pid, 0));
});

test('Skills are discoverable and readable only in assigned sessions; traversal is denied and old snapshot survives update', async t => {
  const { directory, library, connect } = await fixture(t), source = await skillSource(directory);
  const id = await library.importSkill({ directory: source });
  const assigned = await connect({ servers: [], skills: structuredClone(library.data.skills) });
  const empty = await connect({ servers: [], skills: [] }); assert.equal((await empty.client.listTools()).tools.length, 0);
  assert.equal(result(await assigned.client.callTool({ name: 'ar_skills_list' }))[0].id, id);
  assert.ok(result(await assigned.client.callTool({ name: 'ar_skills_read', arguments: { id } })).text.includes('Version one'));
  await assert.rejects(empty.client.callTool({ name: 'ar_skills_read', arguments: { id } }));
  await assert.rejects(assigned.client.callTool({ name: 'ar_skills_read', arguments: { id, file: '../library.json' } }));
  await fs.writeFile(path.join(source, 'SKILL.md'), 'Version two'); await library.importSkill({ id, directory: source });
  assert.ok(result(await assigned.client.callTool({ name: 'ar_skills_read', arguments: { id } })).text.includes('Version one'));
});

test('four engine launch adapters inject only session-local MCP config, preserving model and other MCP settings', async t => {
  const { directory, hub } = await fixture(t);
  const c = await hub.session({ directory, workspaceId: 'test', plan: { servers: [], skills: [] } });
  const codex = await capabilityLaunch('codex', c, directory), claude = await capabilityLaunch('claude', c, directory);
  assert.ok(codex.args.some(a => a.includes('bearer_token_env_var'))); assert.ok(!codex.args.join(' ').includes(c.token));
  assert.equal(JSON.parse(claude.args[1]).mcpServers[claude.key].url, c.url);
  const oc = await capabilityLaunch('opencode', c, directory, { OPENCODE_CONFIG_CONTENT: JSON.stringify({ model: 'existing/model', mcp: { original: { type: 'remote', url: 'http://existing/' } } }) });
  const config = JSON.parse(oc.env.OPENCODE_CONFIG_CONTENT); assert.equal(config.model, 'existing/model'); assert.ok(config.mcp.original); assert.ok(config.mcp[oc.key]);
  const pi = await capabilityLaunch('pi', c, directory); assert.equal(pi.args[0], '--extension');
  const generated = await fs.readFile(pi.args[1], 'utf8'); assert.ok(!generated.includes(c.token)); assert.ok(generated.includes('registerTool'));
});

test('generated Pi bridge registers and executes real Hub tools without a model request', async t => {
  const { directory, library, hub, save } = await fixture(t); await save();
  const c = await hub.session({ directory, workspaceId: 'test', plan: { servers: library.data.servers, skills: [] } });
  const adapter = await capabilityLaunch('pi', c, directory);
  const previous = { url: process.env.AGENT_ROOM_MCP_URL, token: process.env.AGENT_ROOM_MCP_TOKEN };
  process.env.AGENT_ROOM_MCP_URL = c.url; process.env.AGENT_ROOM_MCP_TOKEN = c.token;
  const tools = [], handlers = {};
  try {
    const mod = await import(pathToFileURL(adapter.args[1]).href);
    await mod.default({ registerTool: tool => tools.push(tool), on: (name, fn) => { handlers[name] = fn; } });
    const echo = tools.find(t => t.description.includes('echo_workspace')); assert.ok(echo);
    assert.equal(result(await echo.execute('test', { text: 'Pi bridge' }, new AbortController().signal)).text, 'Pi bridge');
  } finally {
    await handlers.session_shutdown?.();
    for (const [key, value] of [['AGENT_ROOM_MCP_URL', previous.url], ['AGENT_ROOM_MCP_TOKEN', previous.token]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('HcomService inherits workspace bindings, injects launch config, exposes assigned status and allows opt-out', async t => {
  const { directory, library, hub } = await fixture(t); const source = await skillSource(directory); const skillId = await library.importSkill({ directory: source });
  const id = workspaceId(directory); await library.bind({ workspaceId: id, serverIds: [], skillIds: [skillId] });
  const calls = [], roster = [];
  const service = new HcomService({ dataDir: directory, run: async (args, timeout, env) => {
    if (args[0] === 'list') return JSON.stringify(roster); if (args[0] === 'events') return '';
    calls.push({ args, env }); const name = `agent-${calls.length}`;
    roster.push({ name, directory, tool: 'codex', session_id: name }); return JSON.stringify({ names: [name] });
  } });
  service.library = library; service.mcpHub = hub;
  await service.launch({ tool: 'codex', directory });
  assert.ok(calls[0].env.AGENT_ROOM_MCP_URL); assert.ok(service.snapshot().agents[0].capabilities.skills.some(s => s.id === skillId));
  await service.launch({ tool: 'codex', directory, capabilities: { mode: 'off' } });
  assert.ok(!calls[1].env.AGENT_ROOM_MCP_URL); assert.equal(service.snapshot().agents[1].capabilities, undefined);
});

test('remote HTTP and SSE upstreams receive encrypted authentication and proxy genuine MCP calls', async t => {
  const { library, save, connect } = await fixture(t), transports = new Set(), sse = new Map();
  const makeServer = () => {
    const server = new Server({ name: 'remote-fixture', version: '1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'ping', inputSchema: { type: 'object' } }] }));
    server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'remote-pong' }] }));
    return server;
  };
  const upstream = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer fixture-only') { res.writeHead(401); res.end(); return; }
    try {
      if (req.url === '/sse') {
        const transport = new SSEServerTransport('/messages', res); transports.add(transport); sse.set(transport.sessionId, transport);
        await makeServer().connect(transport); return;
      }
      if (req.url.startsWith('/messages')) {
        const id = new URL(req.url, 'http://localhost').searchParams.get('sessionId'); await sse.get(id).handlePostMessage(req, res); return;
      }
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); transports.add(transport);
      res.on('close', () => { transports.delete(transport); transport.close(); });
      await makeServer().connect(transport); await transport.handleRequest(req, res);
    } catch { res.writeHead(500); res.end(); }
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await Promise.allSettled([...transports].map(t => t.close())); upstream.closeAllConnections(); upstream.close(); });
  for (const transport of ['http', 'sse']) {
    const id = await save({ name: transport, transport, url: `http://127.0.0.1:${upstream.address().port}/${transport === 'http' ? 'mcp' : 'sse'}`, headers: { Authorization: 'Bearer fixture-only' } });
    const c = await connect({ servers: [library.data.servers.find(s => s.id === id)], skills: [] });
    const tools = (await c.client.listTools()).tools; assert.equal(tools.length, 1);
    assert.equal((await c.client.callTool({ name: tools[0].name })).content[0].text, 'remote-pong');
  }
});

test('a failing MCP does not prevent calling another server and tampered Skill content is rejected', async t => {
  const { directory, library, save, connect } = await fixture(t);
  await save({ name: 'Missing', command: path.join(directory, 'missing.exe') }); await save({ name: 'Working' });
  const source = await skillSource(directory), id = await library.importSkill({ directory: source });
  const c = await connect({ servers: structuredClone(library.data.servers), skills: structuredClone(library.data.skills) });
  const tools = (await c.client.listTools()).tools, echo = tools.find(t => t.description.includes('echo_workspace'));
  assert.ok(echo); assert.equal(result(await c.client.callTool({ name: echo.name })).cwd, directory);
  await fs.writeFile(path.join(library.skillPath(library.data.skills[0]), 'SKILL.md'), 'tampered');
  await assert.rejects(c.client.callTool({ name: 'ar_skills_read', arguments: { id } }));
  await assert.rejects(library.importSkill({ id, directory: source }), /外部修改/);
});
