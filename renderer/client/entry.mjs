import { createDefaultChatClient, createPlatformClient } from './bootstrap.mjs';
window.AgentRoomChat = Object.freeze({ createClient: createDefaultChatClient, createPlatform: createPlatformClient });
