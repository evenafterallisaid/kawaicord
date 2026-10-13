const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { runMacUpdateTransaction, validateMacTransaction } = require('../dist/mac-update-transaction');
const { selectMacUpdateFile, validateMacZipEntries, macAppBundle } = require('../dist/mac-updater');

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kawaicord-update-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workDir = path.join(root, '.kawaicord-update-test');
  const tx = { id: 'a'.repeat(32), parentPid: 123, target: path.join(root, 'Kawaicord.app'),
    staged: path.join(workDir, 'Kawaicord.app'), backup: path.join(workDir, 'previous.app'),
    workDir, version: '1.5.0', receipt: path.join(root, 'mac-update.json') };
  for (const [location, content] of [[tx.target, 'old'], [tx.staged, 'new']]) {
    await fs.mkdir(location, { recursive: true });
    await fs.writeFile(path.join(location, 'version'), content);
  }
  const profile = path.join(root, 'profile');
  await fs.mkdir(profile);
  await fs.writeFile(path.join(profile, 'settings'), 'preserve me');
  return { tx, profile };
}
const runtime = overrides => ({ parentAlive: () => false, wait: async () => {}, startupTimeoutMs: 100,
  launch: async () => ({ exited: () => false, stop: async () => {} }), ...overrides });

test('confirmed update swaps the app and leaves the profile untouched', async t => {
  const { tx, profile } = await fixture(t);
  await runMacUpdateTransaction(tx, runtime({ launch: async (_exe, id) => {
    assert.equal(id, tx.id);
    await fs.writeFile(path.join(tx.workDir, 'ack'), `${id}:${tx.version}`);
    return { exited: () => false, stop: async () => {} };
  } }));
  assert.equal(await fs.readFile(path.join(tx.target, 'version'), 'utf8'), 'new');
  assert.equal(await fs.readFile(path.join(profile, 'settings'), 'utf8'), 'preserve me');
  assert.equal(JSON.parse(await fs.readFile(tx.receipt)).phase, 'committed');
  await assert.rejects(fs.stat(tx.backup), { code: 'ENOENT' });
});

test('failed launch restores the previous app and restarts it', async t => {
  const { tx } = await fixture(t);
  let launchedOld = false;
  await assert.rejects(runMacUpdateTransaction(tx, runtime({ launch: async (_exe, id) => {
    if (id) throw new Error('launch failed');
    launchedOld = true;
    return { exited: () => false, stop: async () => {} };
  } })), /launch failed/);
  assert.equal(launchedOld, true);
  assert.equal(await fs.readFile(path.join(tx.target, 'version'), 'utf8'), 'old');
  assert.equal(JSON.parse(await fs.readFile(tx.receipt)).phase, 'rolled-back');
});

test('startup timeout stops only the replacement before rollback', async t => {
  const { tx } = await fixture(t);
  let stopped = false;
  await assert.rejects(runMacUpdateTransaction(tx, runtime({ launch: async (_exe, id) => {
    if (!id) assert.equal(stopped, true);
    return { exited: () => false, stop: async () => { stopped = true; } };
  } })), /did not confirm/);
  assert.equal(await fs.readFile(path.join(tx.target, 'version'), 'utf8'), 'old');
});

test('cancelled handoff does not change the running app', async t => {
  const { tx } = await fixture(t);
  await fs.writeFile(path.join(tx.workDir, 'cancel'), tx.id);
  await assert.rejects(runMacUpdateTransaction(tx, runtime({ parentAlive: () => true })), /cancelled/);
  assert.equal(await fs.readFile(path.join(tx.target, 'version'), 'utf8'), 'old');
  await assert.rejects(fs.stat(tx.backup), { code: 'ENOENT' });
});

test('unresponsive original app is never killed or overwritten', async t => {
  const { tx } = await fixture(t);
  await assert.rejects(runMacUpdateTransaction(tx, runtime({ parentAlive: () => true })), /did not quit/);
  assert.equal(await fs.readFile(path.join(tx.target, 'version'), 'utf8'), 'old');
});

test('out-of-scope backup paths are rejected', async t => {
  const { tx } = await fixture(t);
  assert.throws(() => validateMacTransaction({ ...tx, backup: path.dirname(tx.target) }), /outside/);
  assert.throws(() => validateMacTransaction({ ...tx, target: path.parse(tx.target).root }), /outside/);
});

test('macOS update selection rejects incorrect architecture, host, and missing hashes', () => {
  const file = (arch, host = 'github.com', sha512 = Buffer.alloc(64).toString('base64')) => ({
    url: new URL(`https://${host}/evenafterallisaid/kawaicord/releases/download/v1.5.0/Kawaicord-1.5.0-mac-${arch}.zip`),
    info: { url: '', sha512 }
  });
  assert.equal(selectMacUpdateFile([file('x64'), file('arm64')], 'arm64').url.pathname.endsWith('-arm64.zip'), true);
  assert.equal(selectMacUpdateFile([file('arm64'), file('universal')], 'arm64').url.pathname.endsWith('-universal.zip'), true);
  assert.throws(() => selectMacUpdateFile([file('arm64')], 'x64'));
  assert.throws(() => selectMacUpdateFile([file('universal', 'example.com')], 'x64'));
  assert.throws(() => selectMacUpdateFile([file('universal', 'github.com', '')], 'x64'));
});

test('read-only DMGs and traversal archives are rejected before installation', () => {
  assert.equal(macAppBundle('/Applications/Kawaicord.app/Contents/MacOS/Kawaicord'), '/Applications/Kawaicord.app');
  assert.throws(() => macAppBundle('/Volumes/Kawaicord/Kawaicord.app/Contents/MacOS/Kawaicord'));
  assert.throws(() => macAppBundle('/private/var/AppTranslocation/id/Kawaicord.app/Contents/MacOS/Kawaicord'));
  validateMacZipEntries(['Kawaicord.app/Contents/Info.plist', '__MACOSX/Kawaicord.app/file']);
  for (const entry of ['/tmp/file', 'Kawaicord.app/../../file', 'Other.app/file']) {
    assert.throws(() => validateMacZipEntries([entry]));
  }
});
