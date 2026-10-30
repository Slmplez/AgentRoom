const { test } = require('node:test');
const assert = require('node:assert/strict');
const { toolDiffs } = require('../lib/rpc/tool-diffs.cjs');
const patch='--- a/example.js\n+++ b/example.js\n@@ -1 +1 @@\n-old\n+new\n';
test('native changes and unified tool output retain actual patch content', () => {
  assert.equal(toolDiffs({output:patch})[0].patch,patch);
  assert.equal(toolDiffs({changes:[{path:'example.js',diff:'@@ -1 +1 @@\n-old\n+new\n'}]})[0].patch,patch);
  assert.equal(toolDiffs({patch})[0].patch,patch);
  assert.deepEqual(toolDiffs({output:'Edited example.js successfully'}),[]);
});
test('oversized patches are reported instead of silently previewing an incomplete diff', () => {
  const result=toolDiffs({patch:patch+' '.repeat(256000)});
  assert.equal(result[0].patch,undefined); assert.match(result[0].unavailable,/超过/);
});
