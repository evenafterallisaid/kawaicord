import { LocalListeningController, type ListeningFrame } from './spotify-companion-controller';
declare const Spicetify: any;
// replaced locally when the user installs the companion; never shipped with an account credential.
const pairing = 'KAWAICORD_PAIRING_KEY';
function start(attempt = 0) {
  if (typeof Spicetify === 'undefined' || !Spicetify.Player?.playUri || !Spicetify.Platform?.PlayerAPI?.seekTo) {
    if (attempt < 60) setTimeout(() => start(attempt + 1), 1000);
    return;
  }
  if ((window as any).__kawaicordSpotifyCompanion) return;
  (window as any).__kawaicordSpotifyCompanion = true;
  let socket: WebSocket | undefined, stopped = false, retry: ReturnType<typeof setTimeout> | undefined;
  let backoff = 1000;
  const player = Spicetify.Player;
  const controller = new LocalListeningController({
    uri: () => player.data?.item?.uri, playing: () => player.isPlaying(), position: () => player.getProgress(), duration: () => player.getDuration(),
    play: (uri) => player.playUri(uri), seek: async (ms) => { await Spicetify.Platform.PlayerAPI.seekTo(ms); },
    resume: async () => { await Spicetify.Platform.PlayerAPI.resume(); }, pause: async () => { await Spicetify.Platform.PlayerAPI.pause(); }
  }, (revision, result) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ revision, result }));
    if (result === 'error') Spicetify.showNotification('Kawaicord could not start local Spotify playback. Listen Along was stopped.', true);
  });
  const listeners = [['songchange', 'song'], ['onplaypause', 'pause'], ['onprogress', 'progress']] as const;
  for (const [event, kind] of listeners) player.addEventListener(event, () => controller.observe(kind));
  function connect() {
    if (stopped) return;
    socket = new WebSocket(`ws://127.0.0.1:19779/kawaicord-listen-along?key=${pairing}`);
    socket.onopen = () => { backoff = 1000; };
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string' || event.data.length > 4096) return;
      try { const frame = JSON.parse(event.data) as ListeningFrame; if (frame && typeof frame === 'object') controller.update(frame); } catch {}
    };
    socket.onerror = () => socket?.close();
    socket.onclose = () => { controller.disconnect(); if (!stopped) { retry = setTimeout(connect, backoff); backoff = Math.min(30_000, backoff * 2); } };
  }
  window.addEventListener('pagehide', () => { stopped = true; if (retry) clearTimeout(retry); controller.disconnect(); socket?.close(); }, { once: true });
  connect();
}
start();
