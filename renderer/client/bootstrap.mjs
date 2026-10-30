import { createAgentRoomClient } from './client.mjs';
import { createChatTransport, createHttpChannel } from './transport.mjs';

export function createPlatformClient(host = globalThis.agentRoom) {
  return {
    capabilities: Object.freeze({ windowControls: typeof host?.windowAction === 'function' }),
    windowAction(action) {
      if (!['minimize', 'maximize', 'close'].includes(action) || !host?.windowAction) return false;
      host.windowAction(action);
      return true;
    },
  };
}
export function createDefaultChatClient(channel = globalThis.agentRoomChat || createHttpChannel()) {
  return createAgentRoomClient(createChatTransport(channel));
}
