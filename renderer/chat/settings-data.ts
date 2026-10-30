import { useEffect, useRef, useState } from 'react';
import type { ChatClient, Command, Query, QueryResult } from './types';

// Each view owns its read generation. A late response cannot reopen or replace another view.
export function useSettingsQuery<T extends 'connections' | 'capabilities' | 'catalog' | 'usage'>(client: ChatClient, type: T, active: boolean) {
  const [data, setData] = useState<QueryResult<T>>();
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [version, setVersion] = useState(0);
  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoading(true); setError('');
    void client.query({ type } as Query & { type: T }).then(value => { if (current) setData(value); }, failure => { if (current) setError(failure.message); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [client, type, active, version]);
  return { data, error, loading, refresh: () => setVersion(v => v + 1) };
}

export function useSettingsActions(client: ChatClient, live: boolean) {
  const pending = useRef(false), unknown = useRef(new Set<string>());
  const [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const blocked = (operation: string) => !live || busy || unknown.current.has(operation);
  async function run(operation: string, command: Command) {
    if (pending.current || blocked(operation)) return;
    pending.current = true; setBusy(true); setMessage('');
    try {
      const receipt = await client.dispatch(command);
      if (!receipt.accepted) throw new Error('操作未被接受，请检查当前状态。');
      setMessage('已保存。');
      return receipt;
    } catch (error) {
      const failure = error as Error & { outcome?: string };
      if (failure.outcome === 'unknown') unknown.current.add(operation);
      setMessage(failure.outcome === 'unknown' ? '操作结果尚未确认，已暂停此操作的重复提交。请核查列表中的实际状态。' : failure.message);
    } finally { pending.current = false; setBusy(false); }
  }
  return { busy, message, run, blocked, unknown };
}
export type SettingsActions = ReturnType<typeof useSettingsActions>;
export const requestKey = () => crypto.randomUUID();
export const formText = (form: FormData, name: string) => String(form.get(name) || '').trim();
