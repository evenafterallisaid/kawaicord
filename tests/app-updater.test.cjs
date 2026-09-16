const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.join(__dirname, '..');
const main = fs.readFileSync(path.join(projectRoot, 'dist', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(projectRoot, 'dist', 'preload.js'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
const releaseWorkflow = fs.readFileSync(
  path.join(projectRoot, '.github', 'workflows', 'release.yml'),
  'utf8'
);

test('installed builds update from the Kawaicord GitHub Releases feed', () => {
  assert.equal(packageJson.build.publish[0].provider, 'github');
  assert.equal(packageJson.build.publish[0].owner, 'evenafterallisaid');
  assert.equal(packageJson.build.publish[0].repo, 'kawaicord');
  assert.match(main, /autoUpdater\.checkForUpdates\(\)/);
  assert.match(main, /autoUpdater\.autoDownload = true/);
  assert.match(main, /autoUpdater\.autoInstallOnAppQuit = true/);
  assert.match(main, /Update request rejected from an untrusted renderer/);
  assert.match(releaseWorkflow, /electron-builder --win nsis --publish always|npm run release/);
  assert.match(releaseWorkflow, /GH_TOKEN/);
});

test('update UI exposes manual checks, automatic checks, progress, and controlled install', () => {
  assert.match(preload, /Automatic App Updates/);
  assert.match(preload, /kawaicord-app-update-toggle/);
  assert.match(preload, /kawaicord-check-update-btn/);
  assert.match(preload, /kawaicord-update-progress-fill/);
  assert.match(preload, /Restart and update/);
  assert.match(main, /autoUpdateApp/);
  assert.match(main, /autoUpdater\.quitAndInstall\(false, true\)/);
  assert.match(main, /flushStorageData\(\)/);
  assert.match(main, /updateRecoveryState\(true\)/);
  assert.match(main, /appUpdateStatus\.phase === 'downloaded'[\s\S]*installDownloadedAppUpdate\(\)/);
});

test('network refreshes do not block creation of the Discord window', () => {
  assert.match(main, /createWindow\(\);[\s\S]*scheduleModBundleRefresh\(30_?000\)/);
  assert.match(main, /Discord UI ready\.[\s\S]*scheduleModBundleRefresh\(5_?000\)/);
});
