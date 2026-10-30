import { randomUUID } from 'node:crypto';
import { clientError } from '../contracts/chat.mjs';

function privateInput(input) {
  const { apiKey, passphrase } = input.credentials;
  return { ...input.profile, id: input.id,
    ...(apiKey.action === 'replace' ? { apiKey: apiKey.value } : {}), clearApiKey: apiKey.action === 'clear',
    ...(passphrase.action === 'replace' ? { clientKeyPassphrase: passphrase.value } : {}), clearPassphrase: passphrase.action === 'clear' };
}
export function createConnectionApi(service) {
  return {
    query(input) {
      if (input.type === 'connections') return { profiles: service.connections.list(), secureStorageAvailable: service.connections.secureAvailable(), simulated: false };
      if (input.type === 'modelCatalog') return service.modelCatalog(input.connectionId, input.model);
      return service.testConnection(privateInput(input));
    },
    async execute(command) {
      if (command.type === 'removeConnection') {
        if (!service.connections.list().some(p => p.id === command.id)) throw clientError('not_found', '连接配置不存在。');
        await service.removeConnection(command.id);
        return { accepted: true, operationId: randomUUID(), entityId: command.id };
      }
      const payload = privateInput(command);
      try { await service.connections.resolve(payload); }
      catch (error) { throw clientError('invalid_connection', error.message); }
      const result = await service.saveConnection(payload);
      return { accepted: true, operationId: randomUUID(), entityId: result.id };
    },
  };
}
