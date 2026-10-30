import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sqliteBackend} from './sqlite.ts';
import {Souls} from './soul.ts';
const sample={id:'same-id',scope:'agent:a',text:'Preference: concise bullet lists',source:'fixture://message-1',task:'task-1',revision:1};
test('memory survives reopening; scopes with the same ID stay independent',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'agentroom-memory-'));const path=join(dir,'test.sqlite');
  let db=sqliteBackend(path);await db.put(sample);await db.put({...sample,scope:'agent:b',text:'Preference: detailed paragraphs'});await db.close();
  db=sqliteBackend(path);
  try{assert.equal((await db.search('agent:a','concise'))[0]?.source,sample.source);assert.equal((await db.search('agent:b','concise')).length,0);assert.equal((await db.search('agent:b','paragraphs'))[0]?.id,sample.id);}finally{await db.close();}
});
test('idempotence, stale correction rejection and deletion tombstone survive restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'agentroom-memory-'));const path=join(dir,'test.sqlite');let db=sqliteBackend(path);
  await db.put(sample);await db.put(sample);assert.equal((await db.history(sample.scope,sample.id)).length,1);
  await db.put({...sample,text:'Preference: paragraphs',revision:2});await assert.rejects(db.put(sample),/revision_conflict/);
  await db.forget(sample.scope,sample.id);await db.close();db=sqliteBackend(path);
  try{await db.put(sample);assert.equal((await db.search(sample.scope,'concise paragraphs')).length,0);assert.equal((await db.history(sample.scope,sample.id)).length,2);}finally{await db.close();}
});
test('Soul edit permissions and per-Agent identity persist independently',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'agentroom-soul-'));const path=join(dir,'soul.sqlite');let db=new Souls(path);
  const a={agentId:'a',name:'A',personality:'谨慎',expression:'简洁',workStyle:'证据优先',revision:1};const b={...a,agentId:'b',name:'B',personality:'热情'};
  db.edit('human-owner',a);db.edit('human-owner',b);
  assert.throws(()=>db.edit('memory-extractor',{...a,personality:'被覆盖',revision:2}),/forbidden/);
  db.edit('human-owner',{...a,expression:'简洁但温和',revision:2});assert.deepEqual(db.get('b'),b);
  db.close();db=new Souls(path);try{assert.equal(db.get('a')?.revision,2);assert.deepEqual(db.get('b'),b);}finally{db.close();}
});
