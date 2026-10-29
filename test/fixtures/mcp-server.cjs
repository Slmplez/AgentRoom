const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
let counter = 0;
const server = new Server({ name: 'agent-room-test', version: '1' }, { capabilities: { tools: { listChanged: true } } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: ['echo_workspace', 'write_counter', 'same.one', 'same/one'].map(name => ({ name, description: `Fixture ${name}`, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } })) }));
server.setRequestHandler(CallToolRequestSchema, async request => ({ content: [{ type: 'text', text: JSON.stringify({ name: request.params.name, cwd: process.cwd(), pid: process.pid, counter: request.params.name === 'write_counter' ? ++counter : counter, text: request.params.arguments?.text || '' }) }] }));
server.connect(new StdioServerTransport()).catch(() => process.exit(1));
