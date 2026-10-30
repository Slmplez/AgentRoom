const { test } = require('node:test');
const assert = require('node:assert/strict');
const { tokens, context, insert } = require('../shared/mentions.cjs');
const { resolveTargets } = require('../lib/hcom-service.cjs');
const agents = ['alpha','beta','gamma'].map(id => ({id,name:id,baseName:id,workspaceId:'w'}));
const room = {workspaceId:'w',allMembers:true};
test('consecutive mentions accept Chinese and punctuation and route every selected member', () => {
  const text='@alpha 请@beta，@gamma 检查';
  assert.deepEqual(tokens(text).map(t=>t.name), ['alpha','beta','gamma']);
  assert.deepEqual(resolveTargets(text,room,agents), ['alpha','beta','gamma']);
  assert.deepEqual(resolveTargets('@alpha.',room,agents), ['alpha']);
  assert.deepEqual(resolveTargets('@alpha@beta @alpha',room,agents), ['alpha','beta']);
  assert.throws(()=>resolveTargets('@alpha 请@elsewhere',room,agents), /没有找到/);
});
test('completing a second mention replaces only its token, including the suffix after the cursor', () => {
  const text='@alpha 请@betta 检查', cursor=text.indexOf('tta');
  const position=context(text,cursor);
  assert.equal(position.query,'be');
  assert.equal(insert(text,position,'beta').text,'@alpha 请@beta 检查');
  assert.equal(context('@alpha@b',8).query,'b');
  assert.equal(context('@alpha ',7),null);
});
test('email and npm package content is not an implicit routing instruction', () => {
  assert.deepEqual(tokens('email person@example.com; 使用 @pierre/diffs 和 @scope/package'),[]);
  assert.equal(context('person@exa',10),null);
  assert.equal(context('@pierre/diffs',12),null);
});
