import { DatabaseSync } from 'node:sqlite';
import type { Backend, Record, Hit } from './contracts.ts';

// A transparent lexical baseline. Chinese segmentation is not semantic embedding.
const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
function tokens(text: string) {
  return [...segmenter.segment(text)].filter(x => x.isWordLike).map(x => x.segment.toLowerCase());
}
export function sqliteBackend(path: string): Backend {
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS memories (scope TEXT, id TEXT, body TEXT, PRIMARY KEY(scope,id));
    CREATE TABLE IF NOT EXISTS revisions (scope TEXT, id TEXT, revision INTEGER, body TEXT, PRIMARY KEY(scope,id,revision));
    CREATE TABLE IF NOT EXISTS tombstones (scope TEXT, id TEXT, PRIMARY KEY(scope,id));
    CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(scope UNINDEXED,id UNINDEXED,terms);`);
  return {
    name: 'SQLite / FTS5 + Intl.Segmenter',
    async put(r) {
      if (db.prepare('SELECT 1 FROM tombstones WHERE scope=? AND id=?').get(r.scope,r.id)) return;
      const previous = db.prepare('SELECT body FROM memories WHERE scope=? AND id=?').get(r.scope,r.id);
      if (previous) {
        const old = JSON.parse(previous.body as string);
        if (old.revision === r.revision && JSON.stringify(old) === JSON.stringify(r)) return;
        if (old.revision >= r.revision) throw new Error('revision_conflict');
      }
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT OR REPLACE INTO memories VALUES(?,?,?)').run(r.scope,r.id,JSON.stringify(r));
        db.prepare('INSERT INTO revisions VALUES(?,?,?,?)').run(r.scope,r.id,r.revision,JSON.stringify(r));
        db.prepare('DELETE FROM search WHERE scope=? AND id=?').run(r.scope,r.id);
        db.prepare('INSERT INTO search VALUES(?,?,?)').run(r.scope,r.id,tokens(r.text).join(' '));
        db.exec('COMMIT');
      } catch(e) { db.exec('ROLLBACK'); throw e; }
    },
    async search(scope, query) {
      const match = tokens(query).map(x => '"'+x.replaceAll('"','""')+'"').join(' OR ');
      if (!match) return [];
      return db.prepare(`SELECT m.body,bm25(search) AS rank FROM search JOIN memories m
        ON m.scope=search.scope AND m.id=search.id WHERE search MATCH ? AND search.scope=?
        ORDER BY rank LIMIT 5`).all(match,scope).map(row => ({...JSON.parse(row.body as string),score:-Number(row.rank)}));
    },
    async forget(scope,id) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.prepare('INSERT OR IGNORE INTO tombstones VALUES(?,?)').run(scope,id);
        db.prepare('DELETE FROM memories WHERE scope=? AND id=?').run(scope,id);
        db.prepare('DELETE FROM search WHERE scope=? AND id=?').run(scope,id);
        db.exec('COMMIT');
      } catch(e) {db.exec('ROLLBACK');throw e;}
    },
    async history(scope,id) { return db.prepare('SELECT body FROM revisions WHERE scope=? AND id=? ORDER BY revision').all(scope,id).map(x=>JSON.parse(x.body as string)); },
    async close(){db.close();}
  };
}
