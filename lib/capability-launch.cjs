const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

async function capabilityLaunch(tool, connection, dataDir, env = {}) {
  const { scope, url, token } = connection;
  const key = `agent_room_${scope.id.replaceAll('-', '').slice(0, 10)}`;
  const result = { args: [], env: { AGENT_ROOM_MCP_URL: url, AGENT_ROOM_MCP_TOKEN: token }, key };
  if (tool === 'codex') {
    for (const [field, value] of Object.entries({ url, bearer_token_env_var: 'AGENT_ROOM_MCP_TOKEN' })) result.args.push('-c', `mcp_servers.${key}.${field}=${JSON.stringify(value)}`);
  } else if (tool === 'claude') {
    result.args.push('--mcp-config', JSON.stringify({ mcpServers: { [key]: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }));
  } else if (tool === 'opencode') {
    const previous = env.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT;
    let config = {};
    try { if (previous) config = JSON.parse(previous); if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error(); }
    catch { throw new Error('OpenCode 的会话配置不是有效 JSON，无法合并 MCP 配置。'); }
    config.mcp = { ...config.mcp, [key]: { type: 'remote', url, headers: { Authorization: `Bearer ${token}` }, enabled: true } };
    result.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(config);
  } else if (tool === 'pi') {
    const directory = path.join(dataDir, 'capabilities', 'runtime'); await fs.mkdir(directory, { recursive: true });
    const extension = path.join(directory, `pi-mcp-${scope.id}.mjs`);
    const sdk = entry => pathToFileURL(require.resolve(`@modelcontextprotocol/sdk/client/${entry}.js`).replace(`${path.sep}cjs${path.sep}`, `${path.sep}esm${path.sep}`)).href;
    await fs.writeFile(extension, `// Generated session-local Agent Room MCP bridge. No upstream credentials.\nimport { Client } from ${JSON.stringify(sdk('index'))};\nimport { StreamableHTTPClientTransport } from ${JSON.stringify(sdk('streamableHttp'))};\nexport default async function(pi) {\n  const client = new Client({name:'agent-room-pi',version:'0.1.0'});\n  const transport = new StreamableHTTPClientTransport(new URL(process.env.AGENT_ROOM_MCP_URL), {requestInit:{headers:{Authorization:'Bearer '+process.env.AGENT_ROOM_MCP_TOKEN}},reconnectionOptions:{maxRetries:0}});\n  try {\n    await client.connect(transport,{timeout:20000});\n    const {tools} = await client.listTools({}, {timeout:30000});\n    for (const tool of tools) pi.registerTool({name:tool.name,label:tool.title||tool.name,description:tool.description||tool.name,parameters:tool.inputSchema,async execute(id,params,signal) {\n      const result=await client.callTool({name:tool.name,arguments:params},undefined,{signal,timeout:60000});\n      return {content:result.content.filter(c=>c.type==='text'||c.type==='image'),details:{isError:Boolean(result.isError)}};\n    }});\n    pi.on('session_shutdown',async()=>{await client.close();});\n  } catch {await client.close();throw new Error('Agent Room MCP bridge could not load assigned tools.');}\n}\n`, { mode: 0o600 });
    result.args.push('--extension', extension);
  } else throw new Error('该引擎尚未适配统一能力库，请选择 Codex、Claude Code、Pi 或 OpenCode。');
  return result;
}
module.exports = { capabilityLaunch };
