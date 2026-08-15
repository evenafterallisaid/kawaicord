const test = require('node:test');
const assert = require('node:assert/strict');

const { cssRgbToHex, KAWAICORD_TITLEBAR_CSS } = require('../dist/titlebar.js');
const { restoreWindowState } = require('../dist/window-state.js');

test('titlebar uses Discord theme tokens and reserves a real app inset', () => {
  assert.match(KAWAICORD_TITLEBAR_CSS, /background-color: var\(--background-base-lowest/);
  assert.match(KAWAICORD_TITLEBAR_CSS, /inset: var\(--kawaicord-titlebar-height\) 0 0/);
  assert.doesNotMatch(KAWAICORD_TITLEBAR_CSS, /calc\(100vh/);
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
