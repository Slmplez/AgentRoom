import { randomUUID, createHash } from 'node:crypto';
import { reportSchema } from '../../contracts/artifacts.mjs';
import { persistenceError as fail } from '../../contracts/persistence.mjs';
const stable = value => value && typeof value === 'object' ? Array.isArray(value) ? value.map(stable) : Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])) : value;
const encode = value => JSON.stringify(stable(value));
const hash = text => createHash('sha256').update(text).digest('hex');
export function artifacts(db) {
  function publish(c, task, now) {
    const artifactId = c.artifactId || randomUUID();
    const previous = db.prepare('SELECT * FROM artifact_versions WHERE artifact_id=? ORDER BY version DESC LIMIT 1').get(artifactId);
    if (c.artifactId && !previous) throw fail('not_found','产物不可访问。',404);
    if (previous && (previous.task_id !== task.id || previous.room_id !== task.roomId)) throw fail('not_found','产物不可访问。',404);
    if ((previous?.version || 0) !== c.expectedVersion || (!c.artifactId && c.expectedVersion !== 0)) throw fail('conflict','产物版本已变化。',409);
    const version = c.expectedVersion+1, content = encode(c.spec);
    db.prepare('INSERT INTO artifact_versions VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(artifactId,version,task.roomId,task.id,task.runId,task.ownerAgentId,task.incarnation,c.title,c.catalogVersion,now,hash(content),content);
    return {artifactId,version,title:c.title,catalogVersion:c.catalogVersion};
  }
  const meta = row => ({ artifactId:row.artifact_id, version:row.version, roomId:row.room_id, taskId:row.task_id, runId:row.run_id, producerAgentId:row.agent_id, title:row.title, catalogVersion:row.catalog_version, createdAt:row.created_at, contentHash:row.content_hash });
  function query(q) {
    const rows = db.prepare('SELECT artifact_id,version,room_id,task_id,run_id,agent_id,title,catalog_version,created_at,content_hash FROM artifact_versions WHERE artifact_id=? AND room_id=? AND (? IS NULL OR version<?) ORDER BY version DESC LIMIT ?').all(q.artifactId,q.roomId,q.beforeVersion??null,q.beforeVersion??null,q.limit??1);
    if (q.type==='artifactVersions') {
      if(!rows.length && !db.prepare('SELECT 1 FROM artifact_versions WHERE artifact_id=? AND room_id=?').get(q.artifactId,q.roomId)) throw fail('not_found','产物不可访问。',404);
      return { versions:rows.map(meta), beforeVersion:rows.length===q.limit?rows.at(-1).version:null };
    }
    const row = db.prepare('SELECT * FROM artifact_versions WHERE artifact_id=? AND version=? AND room_id=?').get(q.artifactId,q.version,q.roomId);
    if(!row) throw fail('not_found','产物版本不可访问。',404);
    if(row.catalog_version!==1) throw fail('unsupported_catalog','产物目录版本不受支持。',422);
    try { if(hash(row.content_json)!==row.content_hash) throw Error(); return {...meta(row),spec:reportSchema.parse(JSON.parse(row.content_json))}; }
    catch { throw fail('artifact_unavailable','产物内容缺失或损坏。',409); }
  }
  return {publish,query};
}
