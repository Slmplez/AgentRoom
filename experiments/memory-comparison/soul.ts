import { DatabaseSync } from 'node:sqlite';

export type Soul = { agentId: string; name: string; personality: string; expression: string; workStyle: string; revision: number };
// Application-owned identity, deliberately outside probabilistic memory extraction.
// actorRole is a trusted harness input, NOT a production authentication mechanism.
export class Souls {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('CREATE TABLE IF NOT EXISTS souls(agentId TEXT PRIMARY KEY,body TEXT); CREATE TABLE IF NOT EXISTS soul_history(agentId TEXT,revision INTEGER,body TEXT,PRIMARY KEY(agentId,revision));');
  }
  edit(actorRole: 'human-owner'|'memory-extractor', soul: Soul) {
    if(actorRole !== 'human-owner') throw new Error('soul_edit_forbidden');
    const old = this.get(soul.agentId);
    if(old && soul.revision !== old.revision+1) throw new Error('soul_revision_conflict');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('INSERT OR REPLACE INTO souls VALUES(?,?)').run(soul.agentId,JSON.stringify(soul));
      this.db.prepare('INSERT INTO soul_history VALUES(?,?,?)').run(soul.agentId,soul.revision,JSON.stringify(soul));
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  get(id: string): Soul|null { const row=this.db.prepare('SELECT body FROM souls WHERE agentId=?').get(id);return row?JSON.parse(row.body as string):null; }
  close(){this.db.close();}
}
