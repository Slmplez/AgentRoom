const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { catalog, create } = require('../renderer/avatars.js');
const agents = count => Array.from({ length: count }, (_, index) => ({ id: `agent-${index}`, name: `codex-agent-${index}`, tool: 'codex' }));

test('one random portrait per agent, without replacement while the pool is available', () => {
  for (const random of [() => 0, () => 0.499, () => 0.99999]) {
    const portraits = create({ random });
    const roster = agents(catalog.length);
    portraits.sync(roster);
    assert.equal(new Set(roster.map(agent => portraits.get(agent).id)).size, catalog.length);
    assert.equal(portraits.sync([...roster].reverse()), false);
    assert.equal(portraits.get({ tool: 'codex' }), undefined);
  }
  const first = create({ random: () => 0 }), last = create({ random: () => 0.99999 });
  first.sync(agents(1)); last.sync(agents(1));
  assert.notEqual(first.get(agents(1)[0]).id, last.get(agents(1)[0]).id);
});

test('saved identities survive restart, roster reorder, rename and message sender aliases', () => {
  const roster = agents(4), original = create();
  original.sync(roster);
  const saved = JSON.parse(JSON.stringify(original.export()));
  const restored = create({ saved, random: () => { throw new Error('must not reroll an existing identity'); } });
  assert.equal(restored.sync([...roster].reverse()), false);
  for (const agent of roster) {
    assert.equal(restored.get(agent).id, original.get(agent).id);
    assert.equal(restored.get({ id: agent.name }).id, original.get(agent).id);
  }
  restored.sync([{ ...roster[0], name: 'new-tag-agent-0' }]);
  assert.equal(restored.get({ id: 'new-tag-agent-0' }).id, original.get(roster[0]).id);
  assert.equal(restored.get({ id: roster[0].name }).id, original.get(roster[0]).id);
});

test('an exhausted pool is reused evenly and offline identities do not block live uniqueness', () => {
  const portraits = create({ random: () => 0.5 }), roster = agents(catalog.length * 3 + 1);
  portraits.sync(roster);
  const counts = new Map(catalog.map(item => [item.id, 0]));
  for (const agent of roster) counts.set(portraits.get(agent).id, counts.get(portraits.get(agent).id) + 1);
  assert.equal(Math.max(...counts.values()) - Math.min(...counts.values()), 1);
  const newcomer = { id: 'newcomer', tool: 'pi' };
  portraits.sync([roster[0], newcomer]);
  assert.notEqual(portraits.get(roster[0]).id, portraits.get(newcomer).id);
});

test('all catalog assets exist as WebP, and invalid saved selections are replaced', () => {
  assert.equal(new Set(catalog.map(item => item.id)).size, 16);
  for (const item of catalog) {
    const buffer = fs.readFileSync(path.join(__dirname, '..', 'renderer', item.src));
    assert.equal(buffer.toString('ascii', 0, 4), 'RIFF');
    assert.equal(buffer.toString('ascii', 8, 12), 'WEBP');
  }
  const portraits = create({ saved: { assignments: { 'agent-0': '../../arbitrary.png' } } });
  portraits.sync(agents(1));
  assert.ok(catalog.some(item => item.id === portraits.get(agents(1)[0]).id));
  const migrated = create({ saved: { assignments: { 'agent-0': 'caramel' } }, random: () => { throw new Error('migration must keep the agent identity'); } });
  migrated.sync(agents(1));
  assert.equal(migrated.get(agents(1)[0]).id, 'jade');
});
