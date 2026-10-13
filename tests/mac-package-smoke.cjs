// Exercise staging and replacement with the actual universal app and ZIP.
const { app } = require('electron');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { MacZipUpdater } = require('../dist/mac-updater');
const execute = promisify(execFile);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kawaicord-package-test-'));
  const target = path.join(root, 'Kawaicord.app');
  const profile = path.join(root, 'profile');
  const version = require('../package.json').version;
  const zip = path.resolve(__dirname, `../build/Kawaicord-${version}-mac-universal.zip`);
  let original;
  const getPath = app.getPath.bind(app);
  try {
    await execute('/usr/bin/ditto', [path.resolve(__dirname, '../build/mac-universal/Kawaicord.app'), target]);
    await fs.mkdir(profile);
    await fs.writeFile(path.join(profile, 'kawaicord_config.json'), JSON.stringify({ activeMod: 'equicord', arRPC: false, trayEnabled: false, autoUpdateApp: false }));
    app.getPath = name => name === 'exe' ? path.join(target, 'Contents/MacOS/Kawaicord') : name === 'userData' ? profile : getPath(name);
    const updater = new MacZipUpdater();
    // Bypass only HTTP: staging, identity/signature validation and the detached
    // replacement helper are the production implementation.
    updater.executeDownload = async options => {
      await options.done({ downloadedFile: zip, version });
      return [zip];
    };
    await updater.doDownloadUpdate({ updateInfoAndProvider: {
      info: { version }, provider: { resolveFiles: () => [{
        url: new URL(`https://github.com/evenafterallisaid/kawaicord/releases/download/v${version}/Kawaicord-${version}-mac-universal.zip`),
        info: { url: '', sha512: Buffer.alloc(64).toString('base64') }
      }] }
    } });
    original = spawn('/bin/sleep', ['60'], { stdio: 'ignore' });
    await new Promise((resolve, reject) => { original.once('spawn', resolve); original.once('error', reject); });
    updater.prepared.parentPid = original.pid;
    updater.prepared.args = [`--user-data-dir=${profile}`, '--smoke-test'];
    await updater.prepareInstall();
    original.kill();
    let receipt;
    for (let elapsed = 0; elapsed < 75_000; elapsed += 250) {
      receipt = JSON.parse(await fs.readFile(path.join(profile, 'mac-update.json'), 'utf8'));
      if (['committed', 'rolled-back'].includes(receipt.phase)) break;
      await wait(250);
    }
    assert.equal(receipt.phase, 'committed', JSON.stringify(receipt));
    for (let i = 0; i < 60; i++) {
      const log = await fs.readFile(path.join(profile, 'kawaicord.log'), 'utf8').catch(() => '');
      if (log.includes('Renderer injection ready: Shelter + equicord')) break;
      await wait(250);
    }
    assert.match(await fs.readFile(path.join(profile, 'kawaicord.log'), 'utf8'), /Renderer injection ready: Shelter \+ equicord/);
    assert.equal(JSON.parse(await fs.readFile(path.join(profile, 'kawaicord_config.json'))).activeMod, 'equicord');
    console.log('Universal app update: native ZIP verification, app replacement, relaunch, Equicord injection and settings preservation passed');
    await wait(1000); // Let the smoke-test app finish its controlled exit.
    app.getPath = getPath;
    await fs.rm(root, { recursive: true, force: true });
    app.exit(0);
  } catch (error) {
    console.error(error);
    console.error(await fs.readFile(path.join(profile, 'kawaicord.log'), 'utf8').catch(() => 'No app log in the test profile.'));
    const receipt = JSON.parse(await fs.readFile(path.join(profile, 'mac-update.json'), 'utf8').catch(() => '{}'));
    if (receipt.workDir) console.error(await fs.readFile(path.join(receipt.workDir, 'helper.log'), 'utf8').catch(() => 'No helper log.'));
    console.error(`Preserved diagnostic test directory: ${root}`);
    if (original?.exitCode === null) original.kill();
    app.exit(1);
  }
});
