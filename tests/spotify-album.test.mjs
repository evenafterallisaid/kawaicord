import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import vm from 'node:vm';

const bundle = await build({
  entryPoints: ['native-ui/spotify-album.ts'],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'browser'
});
const endpoint = 'https://api.spotify.com/v1/me/player/play';
const track = 'a'.repeat(22);
const next = 'b'.repeat(22);
const album = 'c'.repeat(22);
const nextAlbum = 'd'.repeat(22);
const party = { id: 'spotify:host' };
const activity = (sync_id, album_id) => ({ sync_id, party, metadata: { album_id } });
const request = id => ({
  url: endpoint,
  query: { device_id: 'desktop' },
  body: { uris: [`spotify:track:${id}`], position_ms: 12345 }
});

function harness() {
  let flux, http, matches, method;
  let time = 0;
  const state = { enabled: true, sync: null, activity: [], device: { id: 'desktop', type: 'Computer' } };
  const module = { exports: {} };
  const window = new EventTarget();
  window.shelter = {
    flux: {
      intercept(fn) { flux = fn; return () => { flux = undefined; }; },
      storesFlat: {
        SpotifyStore: {
          getSyncingWith: () => state.sync,
          getActiveSocketAndDevice: () => ({ device: state.device })
        },
        PresenceStore: { getActivities: () => state.activity }
      }
    },
    http: {
      intercept(verb, match, fn) {
        method = verb;
        matches = match;
        http = fn;
        return () => { http = undefined; };
      }
    }
  };
  vm.runInNewContext(bundle.outputFiles[0].text, { module, window, Date: { now: () => time } });
  module.exports.installSpotifyAlbumContext(() => state.enabled);
  return {
    state, window,
    advance(ms) { time += ms; },
    dispatch(type, value) { flux?.({ type, userId: 'host', activity: value }); },
    put(value, verb = 'put') {
      if (verb !== method || !matches(value.url) || !http) return value;
      let count = 0;
      const result = http(value, outgoing => { count++; return outgoing; });
      assert.equal(count, 1, 'send exactly one play request');
      return result;
    }
  };
}

test('initial join and host transitions use album context with discord’s original device and position', () => {
  const h = harness();
  h.dispatch('ACTIVITY_SYNC', activity(track, album));
  const first = request(track);
  const converted = h.put(first);
  assert.equal(converted.query, first.query);
  assert.equal(converted.body.position_ms, first.body.position_ms);
  assert.equal(converted.body.context_uri, `spotify:album:${album}`);
  assert.equal(converted.body.offset.uri, `spotify:track:${track}`);
  assert.equal(converted.body.uris, undefined);
  assert.deepEqual(first.body.uris, [`spotify:track:${track}`]);

  h.advance(20_000);
  h.state.sync = { userId: 'host', partyId: party.id, trackId: track };
  h.state.activity = [activity(next, nextAlbum)];
  const changed = h.put(request(next));
  assert.equal(changed.body.context_uri, `spotify:album:${nextAlbum}`);
  assert.equal(changed.body.offset.uri, `spotify:track:${next}`);
  assert.equal(changed.body.position_ms, 12345);

  h.dispatch('ACTIVITY_SYNC_STOP');
  const stopped = request(next);
  assert.equal(h.put(stopped), stopped);
});

test('ordinary play and unknown, already contextual, or non-desktop requests pass through intact', () => {
  const h = harness();
  const input = request(track);
  assert.equal(h.put(input), input);
  h.dispatch('ACTIVITY_SYNC', activity(track, 'bad album'));
  assert.equal(h.put(input), input);
  h.dispatch('ACTIVITY_SYNC', activity(track, album));
  h.state.device.type = 'Smartphone';
  assert.equal(h.put(input), input);
  h.state.device.type = 'Computer';
  h.state.enabled = false;
  assert.equal(h.put(input), input);
  h.state.enabled = true;
  const contextual = { ...input, body: { ...input.body, context_uri: 'spotify:playlist:existing' } };
  const differentDevice = { ...input, query: { device_id: 'other' } };
  const otherOrigin = { ...input, url: 'https://example.com/v1/me/player/play' };
  for (const value of [contextual, differentDevice, otherOrigin]) assert.equal(h.put(value), value);
  h.dispatch('ACTIVITY_PLAY', activity(track, album));
  assert.equal(h.put(input), input);
  h.dispatch('ACTIVITY_SYNC', activity(track, album));
  h.window.dispatchEvent(new Event('pagehide'));
  assert.equal(h.put(input), input);
});
