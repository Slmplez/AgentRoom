import React from 'react';
import { createRoot } from 'react-dom/client';
import { createAgentRoomClient } from '../client/client.mjs';
import { createDefaultChatClient, createPlatformClient, createMockPlatformClient } from '../client/bootstrap.mjs';
import { App } from './app';
import type { ChatClient } from './types';

async function boot() {
  const mock = document.documentElement.dataset.mode === 'mock';
  const scenario = mock ? (await import('../client/mock.mjs')).createMockTransport() : undefined;
  const client = (scenario ? createAgentRoomClient(scenario.transport) : createDefaultChatClient()) as unknown as ChatClient;
  const platform = mock ? createMockPlatformClient() : createPlatformClient();
  window.addEventListener('beforeunload', () => { client.close(); scenario?.control.dispose(); }, { once: true });
  createRoot(document.querySelector('#chat-root')!).render(<App client={client} control={scenario?.control} platform={{ desktop: platform.capabilities.windowControls, windowAction: action => { platform.windowAction(action); }, openWorkbench: section => { void platform.openWorkbench(section); } }} />);
}
void boot().catch(error => { document.querySelector('#chat-root')!.textContent = `界面启动失败：${error.message}`; });
