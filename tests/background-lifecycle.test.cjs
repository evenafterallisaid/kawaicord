const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');

test('hidden cache work is delayed, cancelled on restore, and does not repeat', () => {
  const source = fs.readFileSync(require.resolve('../dist/preload.js'), 'utf8');
  const start = source.indexOf('let rendererBackgrounded = false;');
  const end = source.indexOf('function injectPerformanceCss', start);
  assert.ok(start >= 0 && end > start);
  let pending;
  let releases = 0;
  const states = [];
  const context = vm.createContext({
    document: { documentElement: { dataset: {} }, querySelectorAll: () => [] },
    window: {
      clearTimeout() { pending = undefined; },
      setTimeout(callback, delay) { assert.equal(delay, 60000); pending = callback; return 1; }
    },
    electron_1: { webFrame: {
      getResourceUsage: () => ({ images: { size: 128 * 1024 * 1024, liveSize: 0 } }),
      clearCache: () => releases++
    } },
    performance_1: require('../dist/performance.js'),
    states
  });
  vm.runInContext(source.slice(start, end) + '\nbackgroundListeners.add(hidden => states.push(hidden));', context);
  vm.runInContext('applyBackgroundState(true)', context);
  assert.equal(releases, 0);
  assert.equal(typeof pending, 'function');
  vm.runInContext('applyBackgroundState(false)', context);
  assert.equal(pending, undefined);
  vm.runInContext('applyBackgroundState(true)', context);
  const callback = pending;
  pending = undefined;
  callback();
  assert.equal(releases, 1);
  assert.equal(pending, undefined);
  vm.runInContext('applyBackgroundState(true)', context);
  assert.equal(pending, undefined);
  assert.deepEqual(states, [true, false, true]);
});
