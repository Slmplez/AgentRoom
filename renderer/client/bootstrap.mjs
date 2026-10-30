import { createAgentRoomClient } from './client.mjs';
import { createChatTransport, createHttpChannel } from './transport.mjs';
import { clientError } from '../../contracts/chat.mjs';

export function createPlatformClient(host = globalThis.agentRoom) {
  return {
    capabilities: Object.freeze({ windowControls: typeof host?.windowAction === 'function', chooseDirectory: typeof host?.chooseDirectory === 'function', chooseCertificate: typeof host?.chooseCertificate === 'function' }),
    async chooseCertificate(kind) {
      if (!['cert', 'key'].includes(kind)) throw clientError('invalid_input', '不支持的证书类型。');
      if (!host?.chooseCertificate) throw clientError('unavailable', '浏览器不支持本机文件选择，请填写后端可读取的完整路径。');
      return host.chooseCertificate(kind);
    },
    async chooseDirectory() {
      if (!host?.chooseDirectory) throw clientError('unavailable', '浏览器不支持本机目录选择，请填写后端工作目录。');
      return host.chooseDirectory();
    },
    openSource() { if (host?.openSource) return host.openSource(); globalThis.open('https://github.com/Slmplez/AgentRoom', '_blank', 'noopener'); },
    openWorkbench(section = '') {
      if (!['', 'connections', 'capabilities', 'usage', 'launch', 'members', 'permissions'].includes(section)) throw clientError('invalid_input', '未知管理入口。');
      if (host?.openWorkbench) return host.openWorkbench(section);
      const file = document.documentElement.dataset.mode === 'mock' ? 'workbench.html' : 'index.html';
      globalThis.location.assign(`${file}?section=${encodeURIComponent(section)}`);
    },
    windowAction(action) {
      if (!['minimize', 'maximize', 'close'].includes(action) || !host?.windowAction) return false;
      host.windowAction(action);
      return true;
    },
  };
}
export function createMockPlatformClient() {
  return { ...createPlatformClient(null), capabilities: Object.freeze({ windowControls: false, chooseDirectory: true, chooseCertificate: true }),
    chooseDirectory: async () => 'mock://workspace', chooseCertificate: async () => 'mock://certificate.pem' };
}
export function createDefaultChatClient(channel = globalThis.agentRoomChat || createHttpChannel()) {
  return createAgentRoomClient(createChatTransport(channel));
}
