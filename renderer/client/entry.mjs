import { createDefaultChatClient, createPlatformClient, createMockPlatformClient } from './bootstrap.mjs';
import { createAgentRoomClient } from './client.mjs';
import { createMockTransport } from './mock.mjs';
const mock = document.documentElement.dataset.mode === 'mock' ? createMockTransport() : null;
window.AgentRoomChat = Object.freeze({ createClient: () => mock ? createAgentRoomClient(mock.transport) : createDefaultChatClient(), createPlatform: () => mock ? createMockPlatformClient() : createPlatformClient(), controls: mock?.control });
if (mock) window.addEventListener('beforeunload', () => mock.control.dispose(), { once: true });
