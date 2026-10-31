import type { ChatClient } from './types';
import type { MemoryCurationBridge } from './memory-curation-controller';

export function memoryCurationBridge(client: ChatClient): MemoryCurationBridge {
  return {
    status: input => client.query({ type: 'memoryCurationStatus', ...input }),
    history: input => client.query({ type: 'memoryCurationHistory', ...input }),
    configure: input => client.dispatch({ schemaVersion: 1, type: 'configureMemoryCuration', ...input }),
    inspect: input => client.dispatch({ schemaVersion: 1, type: 'inspectMemoryCuration', ...input }),
    pending(input) {
      if (!client.pendingMemoryOperations) throw Error('无法读取原请求日志。');
      return client.pendingMemoryOperations(input);
    },
    subscribe: listener => client.subscribe(listener),
    check(key) {
      if (!client.checkOperation) throw Error('原请求核查不可用。');
      return client.checkOperation(key);
    },
    retry(key) {
      if (!client.retryOperation) throw Error('原请求重试不可用。');
      return client.retryOperation(key);
    },
  };
}
