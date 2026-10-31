import { createHash, randomUUID } from 'node:crypto';
import { attachmentLimits, attachmentSchema } from '../../contracts/attachments.mjs';
import { persistenceError as fail } from '../../contracts/persistence.mjs';

export const contentHash = bytes => createHash('sha256').update(bytes).digest('hex');
export function validateAttachmentBytes(command, bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length !== command.size || bytes.length < 1 || bytes.length > attachmentLimits.fileBytes || contentHash(bytes) !== command.sha256) throw fail('invalid_attachment', '附件长度或摘要不匹配。');
  const data = Buffer.from(bytes), ext = command.name.split('.').at(-1).toLowerCase();
  if (['txt', 'md', 'csv', 'json', 'log'].includes(ext)) {
    try { const text = new TextDecoder('utf-8', { fatal: true }).decode(data); if (text.includes('\0')) throw Error(); }
    catch { throw fail('invalid_attachment', '文本附件必须是 UTF-8 且不能包含空字符。'); }
    return 'text/plain';
  }
  const match = ext === 'pdf' ? data.subarray(0, 5).equals(Buffer.from('%PDF-'))
    : ext === 'png' ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    : ['jpg', 'jpeg'].includes(ext) ? data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255
    : ext === 'webp' && data.length >= 12 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP';
  if (!match) throw fail('invalid_attachment', '附件签名与文件类型不匹配。');
  return ext === 'pdf' ? 'application/pdf' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
}

// Called inside the owning Runtime transaction. No filesystem paths or independent commits.
export function attachments(db) {
  const project = row => attachmentSchema.parse({ id: row.id, roomId: row.room_id, uploaderId: row.uploader_id, name: row.name, size: row.size, sha256: row.sha256, mediaType: row.media_type, createdAt: row.created_at, expiresAt: row.expires_at, status: row.status, revision: row.revision });
  function read(id, roomId, actor, now) {
    const row = db.prepare('SELECT * FROM attachments WHERE id=? AND room_id=?').get(id, roomId);
    if (!row || row.status === 'deleted' || row.status === 'pending' && row.uploader_id !== actor.id) throw fail('not_found', '附件不可访问。', 404);
    if (row.status === 'pending' && row.expires_at <= now) throw fail('attachment_expired', '暂存附件已过期，请重新选择上传。', 410);
    return row;
  }
  function upload(c, bytes, actor, now) {
    const mediaType = validateAttachmentBytes(c, bytes);
    if (db.prepare('SELECT COALESCE(SUM(size),0) AS total FROM attachments WHERE content IS NOT NULL').get().total + bytes.length > attachmentLimits.databaseBytes) throw fail('attachment_quota', '附件存储额度已满，请移除未发送的附件。', 409);
    const id = randomUUID(), expires = new Date(Date.parse(now) + attachmentLimits.pendingMs).toISOString();
    db.prepare('INSERT INTO attachments(id,room_id,uploader_id,name,size,sha256,media_type,created_at,expires_at,status,revision,content) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,c.roomId,actor.id,c.name,bytes.length,c.sha256,mediaType,now,expires,'pending',1,bytes);
    return project(read(id,c.roomId,actor,now));
  }
  function link(ids, roomId, actor, now) {
    const rows = ids.map(id => read(id,roomId,actor,now));
    if (rows.some(row => row.uploader_id !== actor.id)) throw fail('forbidden', '只能关联自己上传的附件。', 403);
    if (rows.reduce((total,row) => total + row.size,0) > attachmentLimits.totalBytes) throw fail('attachment_limit', '附件总大小不能超过 20 MiB。');
    for (const row of rows) {
      if (!row.content || row.content.length !== row.size || contentHash(row.content) !== row.sha256) throw fail('attachment_unavailable', '附件内容缺失或损坏。', 409);
      if (row.status === 'pending') { db.prepare("UPDATE attachments SET status='linked',expires_at=NULL,revision=revision+1 WHERE id=?").run(row.id); row.status='linked'; row.expires_at=null; row.revision++; }
    }
    return rows.map(project);
  }
  function remove(c, actor, now) {
    const row=read(c.attachmentId,c.roomId,actor,now);
    if (row.uploader_id !== actor.id || row.status !== 'pending') throw fail('conflict', '已关联的附件不能从暂存区删除。', 409);
    db.prepare("UPDATE attachments SET content=NULL,status='deleted',revision=revision+1 WHERE id=?").run(row.id);
    return project({...row,status:'deleted',revision:row.revision+1});
  }
  function query(q, actor, now) {
    if(q.type==='attachment') return project(read(q.attachmentId,q.roomId,actor,now));
    const rows=db.prepare("SELECT id,room_id,uploader_id,name,size,sha256,media_type,created_at,expires_at,status,revision FROM attachments WHERE room_id=? AND uploader_id=? AND status='pending' AND expires_at>? AND id>? ORDER BY id LIMIT ?").all(q.roomId,actor.id,now,q.afterId||'',q.limit+1);
    return {attachments:rows.slice(0,q.limit).map(project),afterId:rows.length>q.limit?rows[q.limit-1].id:null};
  }
  function download(q, actor, now) {
    const row=read(q.attachmentId,q.roomId,actor,now);
    if(!row.content || row.content.length!==row.size || contentHash(row.content)!==row.sha256) throw fail('attachment_unavailable','附件内容缺失或损坏。',409);
    return { metadata: project(row), bytes: Buffer.from(row.content) };
  }
  function prune(now) { db.prepare("DELETE FROM attachments WHERE id IN (SELECT id FROM attachments WHERE status IN ('pending','deleted') AND expires_at<=? LIMIT 100)").run(now); }
  return {upload,link,remove,query,download,prune};
}
