// Run with Electron. Uses a disposable profile and a fake credential, never a user's key.
const { app, safeStorage } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { ConnectionProfiles } = require('../lib/connection-profiles.cjs');
app.setName('Agent Room Verification');
app.whenReady().then(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-room-dpapi-'));
  try {
    assert.equal(safeStorage.isEncryptionAvailable(), true);
    const store = new ConnectionProfiles({ dataDir: dir, secretStorage: safeStorage });
    const fake = 'FAKE-TEST-KEY-WINDOWS-ENCRYPTION';
    const id = await store.save({ name: 'Verification only', protocol: 'responses', baseUrl: 'https://localhost.invalid/v1', model: 'test-model', authMode: 'bearer', apiKey: fake });
    const file = await fs.readFile(path.join(dir, 'connections.json'), 'utf8');
    assert.ok(!file.includes(fake));
    const loaded = new ConnectionProfiles({ dataDir: dir, secretStorage: safeStorage }); await loaded.load();
    assert.equal(loaded.get(id).secrets.apiKey, fake);
    assert.ok(!JSON.stringify(loaded.list()).includes(fake));
    console.log(JSON.stringify({ windowsEncryption: true, persistedEncrypted: true, reloadDecrypts: true, rendererReceivesNoKey: true }));
    await fs.rm(dir, { recursive: true, force: true });
    app.exit(0);
  } catch (error) { console.error(error.message); await fs.rm(dir, { recursive: true, force: true }); app.exit(1); }
});
