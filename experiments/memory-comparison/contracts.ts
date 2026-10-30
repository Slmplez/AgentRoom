export type Record = {
  id: string; scope: string; text: string; source: string; task: string; revision: number;
};
export type Hit = Record & { score?: number; backendId?: string };
export type Backend = {
  name: string;
  put(record: Record): Promise<void>;
  search(scope: string, query: string): Promise<Hit[]>;
  forget(scope: string, id: string): Promise<void>;
  history(scope: string, id: string): Promise<unknown[]>;
  close(): Promise<void>;
};
