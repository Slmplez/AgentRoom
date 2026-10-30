import { randomUUID } from 'node:crypto';
import { publicCapabilityServer } from '../contracts/capabilities.mjs';
export function createCapabilityApi(service) {
  return {
    query(input) {
      if (input.type === 'testCapabilityServer') return service.testCapabilityServer(input);
      const library = service.library.snapshot();
      const servers = library.servers.map(publicCapabilityServer);
      return { ...library, servers, error: library.error || (servers.some(s => s.redacted) ? '旧 MCP 配置中的 URL 查询参数和凭证参数已隐藏；编辑前请将认证迁移至加密环境变量或请求头。' : ''), agents: service.snapshot().agents.filter(a => a.capabilities).map(a => ({ agentId: a.id, ...a.capabilities })), simulated: false };
    },
    async execute(command) {
      let result;
      if (command.type === 'saveCapabilityServer') result = await service.saveCapabilityServer(command.server);
      else if (command.type === 'importSkill') result = await service.importCapabilitySkill(command);
      else if (command.type === 'removeCapability') await service.removeCapability(command);
      else await service.bindCapabilities(command);
      return { accepted: true, operationId: randomUUID(), ...(result?.id ? { entityId: result.id } : {}) };
    },
  };
}
