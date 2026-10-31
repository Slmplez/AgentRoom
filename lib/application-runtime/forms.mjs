import { randomUUID,createHash } from 'node:crypto';
import { formSchema,validateFormValues,formResponseSchema,formStateSchema } from '../../contracts/forms.mjs';
import { persistenceError as fail } from '../../contracts/persistence.mjs';
const stable=value=>value&&typeof value==='object'?Array.isArray(value)?value.map(stable):Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const encode=value=>JSON.stringify(stable(value)), hash=text=>createHash('sha256').update(text).digest('hex');

// Private behavior module. The Runtime owns every transaction, receipt and message.
export function forms(db,{linkAttachments}) {
  const save=wait=>db.prepare('INSERT INTO form_waits(id,task_id,artifact_id,version,state_json) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET state_json=excluded.state_json').run(wait.id,wait.taskId,wait.artifactId,wait.version,JSON.stringify(wait));
  function read(artifactId,version,roomId) {
    const row=db.prepare('SELECT state_json FROM form_waits WHERE artifact_id=? AND version=?').get(artifactId,version);
    if(!row) throw fail('not_found','表单不可访问。',404);
    const wait=JSON.parse(row.state_json);if(wait.roomId!==roomId)throw fail('not_found','表单不可访问。',404);return wait;
  }
  function definition(wait) {
    const row=db.prepare("SELECT content_json,content_hash,catalog_version FROM artifact_versions WHERE artifact_id=? AND version=? AND kind='form'").get(wait.artifactId,wait.version);
    if(row && row.catalog_version!==1)throw fail('unsupported_catalog','该表单目录版本尚不受支持。',409);
    try {if(!row || hash(row.content_json)!==row.content_hash)throw Error();return formSchema.parse(JSON.parse(row.content_json));}
    catch {throw fail('artifact_unavailable','表单内容缺失或损坏。',409);}
  }
  function response(wait,revision=wait.responseRevision) {
    if(!revision)return null;
    const row=db.prepare('SELECT payload_json,content_hash FROM form_responses WHERE artifact_id=? AND version=? AND revision=?').get(wait.artifactId,wait.version,revision);
    try {if(!row || hash(row.payload_json)!==row.content_hash)throw Error();return formResponseSchema.parse(JSON.parse(row.payload_json));}
    catch {throw fail('artifact_unavailable','已保存答复缺失或损坏。',409);}
  }
  const latest=wait=>db.prepare('SELECT MAX(version) AS version FROM artifact_versions WHERE artifact_id=?').get(wait.artifactId).version;
  function current(wait,live) {if(latest(wait)!==wait.version)throw fail('conflict','已有新的表单版本，请保留草稿后打开新版本。',409);if(wait.status!=='waiting'||!live)throw fail('expired','原表单等待已经失效或正在继续。',409);}
  function publish(c,task,now) {
    const artifactId=c.artifactId||randomUUID(),previous=db.prepare('SELECT * FROM artifact_versions WHERE artifact_id=? ORDER BY version DESC LIMIT 1').get(artifactId);
    if(c.artifactId && (!previous || previous.room_id!==task.roomId || previous.task_id!==task.id || previous.run_id!==task.runId || previous.kind!=='form')) throw fail('not_found','表单不可更新。',404);
    if((previous?.version||0)!==c.expectedVersion)throw fail('conflict','表单版本已变化。',409);
    const version=c.expectedVersion+1,content=encode(c.spec);
    db.prepare('INSERT INTO artifact_versions(artifact_id,version,room_id,task_id,run_id,agent_id,incarnation,title,catalog_version,created_at,content_hash,content_json,kind) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(artifactId,version,task.roomId,task.id,task.runId,task.ownerAgentId,task.incarnation,c.title,1,now,hash(content),content,'form');
    const wait={id:randomUUID(),artifactId,version,taskId:task.id,runId:task.runId,incarnation:task.incarnation,ownerAgentId:task.ownerAgentId,roomId:task.roomId,goal:task.goal,title:c.title,status:'waiting',revision:1,responseRevision:0};save(wait);
    return {ref:{artifactId,version,title:c.title,catalogVersion:1,kind:'form'},wait};
  }
  function submit(c,actor,now,live) {
    const wait=read(c.artifactId,c.version,c.roomId);current(wait,live);
    if(wait.responseRevision!==c.expectedResponseRevision)throw fail('conflict','答复已被更新，请保留草稿并读取最新修订。',409);
    const spec=definition(wait),validation=validateFormValues(spec,c.values);
    if(!validation.ok)throw fail('invalid_form',Object.values(validation.errors).join(' '));
    const ids=[...new Set(spec.groups.flatMap(g=>g.fields).filter(f=>f.type==='attachments').flatMap(f=>c.values[f.id]||[]))];
    if(ids.length>5)throw fail('attachment_limit','一次答复最多关联 5 个不同附件。');
    const attachmentRefs=linkAttachments(ids,c.roomId,actor,now);
    const item=formResponseSchema.parse({revision:wait.responseRevision+1,authorId:actor.id,createdAt:now,values:validation.values,attachmentRefs}),content=encode(item);
    db.prepare('INSERT INTO form_responses(artifact_id,version,revision,payload_json,content_hash) VALUES(?,?,?,?,?)').run(wait.artifactId,wait.version,item.revision,content,hash(content));
    wait.responseRevision=item.revision;wait.revision++;save(wait);return {wait,response:item};
  }
  function continueWait(c,live) {
    const wait=read(c.artifactId,c.version,c.roomId);current(wait,live);
    if(wait.revision!==c.expectedWaitRevision || wait.responseRevision!==c.responseRevision || !wait.responseRevision)throw fail('conflict','表单等待或已保存答复已变化，请重新核对。',409);
    definition(wait);response(wait);wait.selectedResponseRevision=c.responseRevision;wait.status='pending';wait.revision++;save(wait);return wait;
  }
  function claim(ref,task) {
    const wait=read(ref.artifactId,ref.version,task.roomId);
    if(wait.status!=='pending'||wait.taskId!==task.id||wait.incarnation!==task.incarnation||wait.runId!==task.runId)throw fail('expired','原表单等待已失效。',409);
    const saved=response(wait,wait.selectedResponseRevision);
    wait.status='attempting';wait.deliveryToken=randomUUID();wait.revision++;save(wait);
    return {wait,payload:{acknowledgment:wait.deliveryToken,result:{artifactId:wait.artifactId,version:wait.version,responseRevision:saved.revision,values:saved.values,attachments:saved.attachmentRefs}}};
  }
  function acknowledge(ref,task,token) {
    const wait=read(ref.artifactId,ref.version,task.roomId);
    if(wait.taskId!==task.id||wait.incarnation!==task.incarnation||wait.runId!==task.runId||wait.deliveryToken!==token)throw fail('expired','原工具接收标识失效。',409);
    if(wait.status==='submitted')return wait;
    if(wait.status!=='attempting')throw fail('expired','原工具投递已失效。',409);
    wait.status='submitted';wait.revision++;save(wait);return wait;
  }
  function expire(ref,task) {
    const wait=read(ref.artifactId,ref.version,task.roomId);
    if(wait.taskId!==task.id||wait.incarnation!==task.incarnation || ['submitted','expired','unknown'].includes(wait.status))return wait;
    wait.status=wait.status==='waiting'?'expired':'unknown';wait.revision++;save(wait);return wait;
  }
  function view(wait,live=false) {return formStateSchema.parse({artifactId:wait.artifactId,version:wait.version,latestVersion:latest(wait),taskId:wait.taskId,runId:wait.runId,ownerAgentId:wait.ownerAgentId,roomId:wait.roomId,goal:wait.goal,status:wait.status,waitRevision:wait.revision,responseRevision:wait.responseRevision,response:response(wait),canSubmit:wait.status==='waiting'&&latest(wait)===wait.version&&live});}
  function history(q) {const wait=read(q.artifactId,q.version,q.roomId);const rows=db.prepare('SELECT revision FROM form_responses WHERE artifact_id=? AND version=? AND (? IS NULL OR revision<?) ORDER BY revision DESC LIMIT ?').all(q.artifactId,q.version,q.beforeRevision??null,q.beforeRevision??null,q.limit+1);return {artifactId:q.artifactId,version:q.version,roomId:q.roomId,responses:rows.slice(0,q.limit).map(row=>response(wait,row.revision)),beforeRevision:rows.length>q.limit?rows[q.limit-1].revision:null};}
  return {history,read,publish,submit,continueWait,claim,acknowledge,expire,view};
}
