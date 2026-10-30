import type { z } from 'zod';
import type { snapshotSchema, messageSchema, approvalSchema, commandSchema } from '../../contracts/chat.mjs';
import type { querySchema, queryResults } from '../../contracts/settings.mjs';
export type Query = z.input<typeof querySchema>;
export type QueryResult<T extends Query['type']> = z.infer<(typeof queryResults)[T]>;
export type Snapshot = z.infer<typeof snapshotSchema> & { connection: string; error: string };
export type Message = z.infer<typeof messageSchema>;
export type Approval = z.infer<typeof approvalSchema>;
export type Command = z.infer<typeof commandSchema>;
export type Agent = Snapshot['agents'][number];
export type Room = Snapshot['rooms'][number];
export interface ChatClient {
  query<Q extends Query>(input: Q): Promise<QueryResult<Q['type']>>;
  read(): Snapshot;
  subscribe(listener: () => void): () => void;
  open(): Promise<void>;
  close(): void;
  dispatch(command: Command): Promise<{ accepted: boolean; operationId?: string; entityId?: string }>;
}
export interface PlatformClient { desktop: boolean; windowAction(action: string): void; openWorkbench(section?: string): void }
declare global {
  interface Window {
    icon(name: string): string;
    AgentMentions: { context(text: string, cursor: number, end?: number): { start: number; end: number; query: string } | null; insert(text: string, context: { start: number; end: number }, name: string): { text: string; cursor: number } };
    AgentAvatars: { create(options: { saved?: unknown }): { sync(agents: Agent[]): boolean; get(agent: Agent): { src: string } | null; export(): unknown } };
  }
}
