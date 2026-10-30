import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import { build } from 'esbuild';
const bundle = await build({ entryPoints: ['native-ui/notifications.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser' });
function harness(initiallyEnabled, readPermission = () => Promise.resolve('granted')) {
  const module = { exports: {} }, window = new EventTarget(), document = new EventTarget(), calls = [];
  let enabled = initiallyEnabled;
  const invoke = async (command, args) => { calls.push({ command, args }); if (command === 'notification_permission') return readPermission(args); };
  vm.runInNewContext(bundle.outputFiles[0].text, { module, window, document, EventTarget, Event, crypto: webcrypto });
  const refresh = module.exports.installNotifications(invoke, () => enabled);
  return { window, document, calls, refresh, enable: value => { enabled = value; } };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('enabling notifications after startup installs delivery without a reload', async () => {
  const h = harness(false);
  assert.equal(h.window.Notification.permission, 'denied');
  assert.equal(h.calls.length, 0);
  h.enable(true);
  await h.refresh();
  const notification = new h.window.Notification('test title', { body: 'test body' });
  await settle();
  const sent = h.calls.find(call => call.command === 'notify');
  assert.equal(sent.args.title, 'test title');
  assert.equal(sent.args.body, 'test body');
  let clicks = 0;
  notification.onclick = () => { clicks++; };
  h.window.__kawaicordNotificationClick(sent.args.id);
  h.window.__kawaicordNotificationClick(sent.args.id);
  assert.equal(clicks, 1);
});

test('a notification closed during the initial permission check is never delivered', async () => {
  let finish;
  const h = harness(true, () => new Promise(resolve => { finish = resolve; }));
  const notification = new h.window.Notification('closed');
  notification.close();
  finish('granted');
  await settle();
  assert.equal(h.calls.some(call => call.command === 'notify'), false);
});

test('turning notifications off stops delivery immediately and permission refresh is event driven', async () => {
  let permission = 'denied';
  const h = harness(true, () => Promise.resolve(permission));
  await h.refresh();
  permission = 'granted';
  h.window.dispatchEvent(new Event('focus'));
  await settle();
  assert.equal(h.window.Notification.permission, 'granted');
  h.enable(false);
  new h.window.Notification('disabled');
  await settle();
  assert.equal(h.calls.some(call => call.command === 'notify'), false);
});
