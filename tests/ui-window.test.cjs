const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  cssRgbToHex,
  KAWAICORD_TITLEBAR_CSS,
  KAWAICORD_WINDOW_CONTROLS_CSS
} = require('../dist/titlebar.js');
const { restoreWindowState } = require('../dist/window-state.js');

test('window controls share Discord native app bar without covering its UI', () => {
  assert.match(KAWAICORD_TITLEBAR_CSS, /html:root:root:root/);
  assert.match(KAWAICORD_TITLEBAR_CSS, /--custom-app-top-bar-height: 32px !important/);
  assert.match(KAWAICORD_TITLEBAR_CSS, /div\[class\*="title"\] \+ div\[class\*="trailing"\]/);
  assert.match(KAWAICORD_TITLEBAR_CSS, /--kawaicord-window-controls-reserved-width: 146px/);
  assert.match(KAWAICORD_TITLEBAR_CSS, /margin-right: var\(--kawaicord-window-controls-reserved-width\)/);
  assert.doesNotMatch(KAWAICORD_TITLEBAR_CSS, /#app-mount/);
  assert.doesNotMatch(KAWAICORD_TITLEBAR_CSS, /\.kawaicord-titlebar/);
  assert.match(KAWAICORD_WINDOW_CONTROLS_CSS, /:host/);
  assert.match(KAWAICORD_WINDOW_CONTROLS_CSS, /all: unset/);
  assert.match(KAWAICORD_WINDOW_CONTROLS_CSS, /background-color: var\(--background-base-lowest/);
});

test('third-party themes cannot restyle or collapse protected window chrome', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', 'dist', 'preload.js'), 'utf8');
  assert.match(preload, /attachShadow\(\{ mode: 'closed' \}\)/);
  assert.match(preload, /setImportantStyle\(root, '--custom-app-top-bar-height'/);
  assert.match(preload, /setImportantStyle\(trailing, 'margin-right'/);
  assert.match(preload, /lockWindowControlHost\(host\)/);
  assert.doesNotMatch(KAWAICORD_WINDOW_CONTROLS_CSS, /\.theme-/);
});

test('computed Discord colors are normalized for Electron', () => {
  assert.equal(cssRgbToHex('rgb(0, 0, 0)'), '#000000');
  assert.equal(cssRgbToHex('rgba(17, 18, 20, 0.95)'), '#111214');
  assert.equal(cssRgbToHex('transparent'), null);
});

test('visible saved window bounds are restored', () => {
  assert.deepEqual(
    restoreWindowState(
      { x: 120, y: 80, width: 1400, height: 900, maximized: true },
      [{ x: 0, y: 0, width: 1920, height: 1080 }]
    ),
    { x: 120, y: 80, width: 1400, height: 900, maximized: true }
  );
});

test('off-screen and invalid saved bounds recover safely', () => {
  assert.deepEqual(
    restoreWindowState(
      { x: 5000, y: 5000, width: 200, height: 100 },
      [{ x: 0, y: 0, width: 1920, height: 1080 }]
    ),
    { width: 1280, height: 720, maximized: false }
  );
});
