const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const main = fs.readFileSync(path.join(__dirname, '..', 'dist', 'main.js'), 'utf8');
const preload = fs.readFileSync(path.join(__dirname, '..', 'dist', 'preload.js'), 'utf8');

test('every completed document load gets a mod injection check', () => {
  assert.match(main, /did-finish-load/);
  assert.match(main, /kawaicord:ensureInjection/);
  assert.match(preload, /ipcRenderer\.on\('kawaicord:ensureInjection'/);
  assert.match(preload, /injectionStatus\.attempts < 3/);
});

test('background performance mode preserves notification timers', () => {
  assert.match(preload, /animation-play-state: paused !important/);
  assert.match(preload, /data-kawaicord-backgrounded/);
  assert.doesNotMatch(main, /setFrameRate/);
});

test('renderer reloads show a protected loading surface instead of a blank window', () => {
  assert.match(preload, /kawaicord-boot-splash/);
  assert.match(preload, /attachShadow\(\{ mode: 'closed' \}\)/);
  assert.match(preload, /Loading Discord/);
  assert.match(preload, /kawaicord:discordReady/);
  assert.match(preload, /kawaicord:discordFailed/);
  assert.match(main, /Discord UI did not mount after 20 seconds/);
  assert.match(main, /Discord UI recovery mode/);
  assert.match(preload, /main, nav, \[role="tree"\]/);
});

test('GPU safety fallbacks remain available', () => {
  assert.doesNotMatch(main, /ignore-gpu-blocklist/);
  assert.doesNotMatch(main, /disable-gpu-process-crash-limit/);
});
