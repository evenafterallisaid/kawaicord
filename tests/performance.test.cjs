const assert = require('node:assert/strict');
const test = require('node:test');
const { shouldReleaseImageCache } = require('../dist/performance.js');
const MiB = 1024 * 1024;

test('cache reclamation requires substantial unused memory and protects hot caches', () => {
  assert.equal(shouldReleaseImageCache(128 * MiB, 64 * MiB, false), true);
  assert.equal(shouldReleaseImageCache(127 * MiB, 64 * MiB, false), false);
  assert.equal(shouldReleaseImageCache(256 * MiB, 160 * MiB, false), false);
  assert.equal(shouldReleaseImageCache(0, 0, false), false);
});

test('playing media and invalid accounting prevent cache reclamation', () => {
  assert.equal(shouldReleaseImageCache(256 * MiB, 0, true), false);
  for (const [size, live] of [[NaN, 0], [Infinity, 0], [128 * MiB, -1], [128 * MiB, NaN]]) {
    assert.equal(shouldReleaseImageCache(size, live, false), false);
  }
});
