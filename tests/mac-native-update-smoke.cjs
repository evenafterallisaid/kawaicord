// Exercise the detached helper with real macOS processes in a disposable app
// directory, including an intentionally failing replacement and rollback.
const { app } = require('electron');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
app.on('window-all-closed', () => {});
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function smoke(failing) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kawaicord-native-update-'));
  const workDir = await fs.mkdtemp(path.join(root, '.kawaicord-update-'));
  const tx = { id: 'b'.repeat(32), version: '1.5.0', parentPid: process.pid,
    target: path.join(root, 'Kawaicord.app'), workDir, staged: path.join(workDir, 'Kawaicord.app'),
    backup: path.join(workDir, 'previous.app'), receipt: path.join(root, 'mac-update.json') };
  let helper;
  let original;
  try {
    for (const [bundle, updated] of [[tx.target, false], [tx.staged, true]]) {
      const directory = path.join(bundle, 'Contents', 'MacOS');
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(bundle, 'version'), updated ? 'new' : 'old');
      const script = updated && failing ? '#!/bin/sh\nexit 1\n' : '#!/bin/sh\nprintf "%s" "$$" > "$KAWAICORD_TEST_WORK_DIR/launched-pid"\n'
        + (updated ? 'printf "%s:%s" "$KAWAICORD_TEST_ID" "$KAWAICORD_TEST_VERSION" > "$KAWAICORD_TEST_WORK_DIR/ack"\n' : '')
        + 'exec /bin/sleep 10\n';
      await fs.writeFile(path.join(directory, 'Kawaicord'), script, { mode: 0o755 });
    }
    original = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    await new Promise((resolve, reject) => { original.once('spawn', resolve); original.once('error', reject); });
    tx.parentPid = original.pid;
    const manifest = path.join(workDir, 'transaction.json');
    await fs.writeFile(manifest, JSON.stringify(tx));
    helper = spawn(process.execPath, [path.resolve(__dirname, '../dist/mac-update-helper.js'), manifest], {
      stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1',
        KAWAICORD_TEST_ID: tx.id, KAWAICORD_TEST_VERSION: tx.version, KAWAICORD_TEST_WORK_DIR: workDir }
    });
    const finished = new Promise((resolve, reject) => {
      helper.once('exit', resolve); helper.once('error', reject);
    });
    for (let i = 0; i < 100; i++) {
      if (await fs.readFile(path.join(workDir, 'ready'), 'utf8').catch(() => '') === tx.id) break;
      if (helper.exitCode !== null) throw new Error('Native helper exited before handoff.');
      await wait(100);
    }
    assert.equal(await fs.readFile(path.join(workDir, 'ready'), 'utf8'), tx.id);
    assert.equal(await fs.readFile(path.join(tx.target, 'version'), 'utf8'), 'old');
    original.kill();
    const timer = setTimeout(() => helper.kill(), 15_000);
    try { assert.equal(await finished, failing ? 1 : 0); }
    finally { clearTimeout(timer); }
    assert.equal(await fs.readFile(path.join(tx.target, 'version'), 'utf8'), failing ? 'old' : 'new');
    console.log(failing ? 'Native macOS failed launch rolled back' : 'Native macOS app replacement confirmed');
  } finally {
    if (helper?.exitCode === null) helper.kill();
    if (original?.exitCode === null) original.kill();
    const pid = Number(await fs.readFile(path.join(workDir, 'launched-pid'), 'utf8').catch(() => ''));
    if (pid > 0) { try { process.kill(pid); } catch {} }
    await fs.rm(root, { recursive: true, force: true });
  }
}

app.whenReady().then(async () => {
  try { await smoke(false); await smoke(true); app.exit(0); }
  catch (error) { console.error(error); app.exit(1); }
});
