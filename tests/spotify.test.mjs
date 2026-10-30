import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

const bundle = await build({ entryPoints: ['native-ui/spotify.ts'], bundle: true, write: false, format: 'cjs', platform: 'browser' });
function harness(fetch) {
  class XHR extends EventTarget {
    status = 0;
    open(...args) { this.openArgs = args; }
    send(body) { this.sentBody = body; }
    finish(status) { this.status = status; this.dispatchEvent(new Event('loadend')); }
  }
  const module = { exports: {} };
  const window = { fetch };
  vm.runInNewContext(bundle.outputFiles[0].text, { module, window, URL, Request, XMLHttpRequest: XHR, location: { href: 'https://discord.com/channels/@me' } });
  module.exports.installSpotifyDiagnostics();
  return { ...module.exports, window, XHR };
}
function common() {
  return { SpotifyStore: {
    hasConnectedAccount: () => true,
    getActiveSocketAndDevice: () => ({ socket: { accessToken: 'secret-token', accountId: 'private-account', isPremium: true, socket: { readyState: 1 } }, device: { id: 'private-device', name: 'private-device-name', is_restricted: false } }),
    getSyncingWith: () => null
  } };
}

test('fetch playback diagnostics preserve the request and response and exclude credentials', async () => {
  const response = { status: 403 };
  const calls = [];
  const h = harness(function(...args) { calls.push(args); return Promise.resolve(response); });
  const input = new Request('https://api.spotify.com/v1/me/player/play?device_id=private-device', { method: 'PUT', headers: { authorization: 'Bearer secret-token' }, body: 'private-track' });
  const init = { credentials: 'omit' };
  assert.equal(await h.window.fetch(input, init), response);
  assert.equal(calls[0][0], input);
  assert.equal(calls[0][1], init);
  const result = h.spotifyDiagnostics(common());
  assert.equal(result.play.status, 403);
  assert.match(result.summary, /refused playback/);
  assert.doesNotMatch(JSON.stringify(result), /secret-token|private-account|private-device|private-track/);
});

test('fetch failures keep the original rejection and unrelated requests are ignored', async () => {
  const failure = new Error('test network error');
  const h = harness(() => Promise.reject(failure));
  await assert.rejects(h.window.fetch('https://api.spotify.com.evil.test/v1/me/player/play', { method: 'PUT' }), error => error === failure);
  assert.equal(h.spotifyDiagnostics(common()).play, undefined);
  await assert.rejects(h.window.fetch('https://api.spotify.com/v1/me/player/play', { method: 'PUT' }), error => error === failure);
  assert.equal(h.spotifyDiagnostics(common()).play.status, 0);
});

test('XHR diagnostics preserve open arguments and body, and report a missing device', () => {
  const h = harness(() => Promise.resolve({ status: 204 }));
  const request = new h.XHR();
  const body = { private: 'body' };
  request.open('PUT', 'https://api.spotify.com/v1/me/player/play?device_id=hidden', true, 'username', 'password');
  request.send(body);
  assert.deepEqual(request.openArgs, ['PUT', 'https://api.spotify.com/v1/me/player/play?device_id=hidden', true, 'username', 'password']);
  assert.equal(request.sentBody, body);
  request.finish(404);
  const result = h.spotifyDiagnostics(common());
  assert.equal(result.play.status, 404);
  assert.match(result.summary, /could not find the selected playback device/);
  assert.doesNotMatch(JSON.stringify(result), /hidden|username|password|private/);
});

test('a Spotify success followed by lost sync is distinguished from a rejected request', async () => {
  const h = harness(() => Promise.resolve({ status: 204 }));
  await h.window.fetch('https://api.spotify.com/v1/me/player/play', { method: 'PUT' });
  assert.match(h.spotifyDiagnostics(common()).summary, /accepted the request/);
  const unavailable = common();
  unavailable.SpotifyStore.getActiveSocketAndDevice = () => null;
  assert.match(h.spotifyDiagnostics(unavailable).summary, /start a song/);
});

test('an older request finishing late cannot replace the latest playback result', async () => {
  const responses = [];
  const h = harness(() => new Promise(resolve => responses.push(resolve)));
  const old = h.window.fetch('https://api.spotify.com/v1/me/player/play', { method: 'PUT' });
  const current = h.window.fetch('https://api.spotify.com/v1/me/player/play', { method: 'PUT' });
  assert.equal(h.spotifyDiagnostics(common()).play.status, -1);
  responses[1]({ status: 204 });
  await current;
  responses[0]({ status: 403 });
  await old;
  assert.equal(h.spotifyDiagnostics(common()).play.status, 204);
});
