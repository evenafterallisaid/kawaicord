import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['native-ui/links.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser' });
function harness() {
  const module = { exports: {} }, listeners = {}, calls = [];
  class Anchor { constructor(href) { this.href = href; } hasAttribute() { return false; } }
  vm.runInNewContext(bundle.outputFiles[0].text, { module, HTMLAnchorElement: Anchor, URL, console, location: new URL('https://discord.com/channels/@me'), document: { addEventListener: (name, handler) => { listeners[name] = handler; } } });
  module.exports.installExternalLinks(async (command, args) => { calls.push({ command, args }); });
  const click = (url, overrides = {}) => {
    const event = { type: 'click', isTrusted: true, defaultPrevented: false, button: 0, composedPath: () => url ? [new Anchor(url)] : [{}], preventDefault() { this.defaultPrevented = true; }, ...overrides };
    listeners[event.type]?.(event); return event;
  };
  return { click, calls };
}
test('scrolling, preview loads, synthetic clicks, and channel clicks do not request an external browser', () => {
  const h = harness();
  h.click('https://open.spotify.com/embed/track/11dFghVXANMlKmJXsNCbNl', { type: 'load' });
  h.click(null, { type: 'scroll' }); h.click(null);
  h.click('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl', { isTrusted: false });
  assert.equal(h.calls.length, 0);
});
test('real link activation uses the opener once and preserves discord link warnings and internal navigation', () => {
  const h = harness();
  assert.ok(h.click('https://open.spotify.com/track/11dFghVXANMlKmJXsNCbNl').defaultPrevented);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0].command, 'open_link');
  h.click('https://example.com/', { defaultPrevented: true });
  h.click('https://discord.com/channels/@me'); h.click('javascript:alert(1)');
  assert.equal(h.calls.length, 1);
  h.click('spotify:track:11dFghVXANMlKmJXsNCbNl', { type: 'auxclick', button: 1 });
  assert.equal(h.calls.length, 2);
});
