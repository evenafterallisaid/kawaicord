const assert = require('node:assert/strict');
const test = require('node:test');

const { getRendererReloadRequest } = require('../dist/reload.js');

test('Ctrl+R and F5 use the controlled renderer reload path', () => {
  assert.deepEqual(
    getRendererReloadRequest({ type: 'keyDown', key: 'r', control: true }),
    { ignoreCache: false, reason: 'refresh shortcut' }
  );
  assert.deepEqual(
    getRendererReloadRequest({ type: 'keyDown', key: 'F5' }),
    { ignoreCache: false, reason: 'refresh shortcut' }
  );
});

test('hard refresh shortcuts bypass cache without becoming app restarts', () => {
  assert.deepEqual(
    getRendererReloadRequest({ type: 'keyDown', key: 'R', control: true, shift: true }),
    { ignoreCache: true, reason: 'hard refresh shortcut' }
  );
  assert.deepEqual(
    getRendererReloadRequest({ type: 'keyDown', key: 'F5', shift: true }),
    { ignoreCache: true, reason: 'hard refresh shortcut' }
  );
});

test('reload key repeats and unrelated shortcuts are ignored', () => {
  assert.equal(
    getRendererReloadRequest({ type: 'keyDown', key: 'r', control: true, isAutoRepeat: true }),
    null
  );
  assert.equal(getRendererReloadRequest({ type: 'keyUp', key: 'r', control: true }), null);
  assert.equal(getRendererReloadRequest({ type: 'keyDown', key: 'r' }), null);
});
