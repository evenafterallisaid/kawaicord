const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { routeClientModRestarts } = require('../dist/mod-patches.js');

const workspace = path.resolve(__dirname, '..');
const reloadCall = /(^|[^\w$.])(?:window\s*\.\s*)?location\s*\.\s*reload\s*\(\s*\)/gm;

for (const mod of ['vencord', 'equicord']) {
  test(`routes every ${mod} browser restart through Kawaicord`, () => {
    const source = fs.readFileSync(path.join(workspace, mod, `${mod}.js`), 'utf8');
    const originalCalls = [...source.matchAll(reloadCall)].length;
    const patched = routeClientModRestarts(source);

    assert.ok(originalCalls > 0, `${mod} should contain restart calls`);
    assert.equal(patched.restartHooks, originalCalls);
    assert.equal([...patched.source.matchAll(reloadCall)].length, 0);
    assert.equal(
      [...patched.source.matchAll(/window\.kawaicord\.restart\(\)/g)].length,
      originalCalls
    );
  });
}

test('does not alter unrelated reload methods', () => {
  const source = 'player.reload(); object.location.reload(); location.reload(true);';
  const patched = routeClientModRestarts(source);

  assert.equal(patched.restartHooks, 0);
  assert.equal(patched.source, source);
});
