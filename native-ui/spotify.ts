import { spotifyPlaybackBeginning, spotifyPlaybackCompleted, spotifyLocalStatus } from './spotify-local';
interface SpotifyRequest { endpoint: string; method: string; status: number; at: number }
let latestPlay: SpotifyRequest | undefined;
let installed = false;
let sequence = 0;

function isPlaybackUrl(input: string): boolean {
  try {
    const url = new URL(input, location.href);
    return url.protocol === 'https:' && url.hostname === 'api.spotify.com' &&
      url.port === '' && url.pathname === '/v1/me/player/play';
  } catch { return false; }
}

// retain status codes only. tokens, account ids, track ids, and request bodies stay out.
export function installSpotifyDiagnostics() {
  if (installed) return;
  installed = true;
  const begin = () => {
    latestPlay = { endpoint: '/v1/me/player/play', method: 'PUT', status: -1, at: Date.now() };
    spotifyPlaybackBeginning(++sequence);
    return sequence;
  };
  const complete = (attempt: number, status: number) => {
    if (attempt) { if (attempt === sequence && latestPlay) latestPlay.status = status; spotifyPlaybackCompleted(attempt); }
  };
  const originalFetch = window.fetch;
  window.fetch = function(input, init) {
    const request = input instanceof Request;
    const method = (init?.method ?? (request ? input.method : 'GET')).toUpperCase();
    if (method !== 'PUT' || !isPlaybackUrl(request ? input.url : String(input))) {
      return originalFetch.call(this, input, init);
    }
    const attempt = begin();
    return originalFetch.call(this, input, init).then(response => {
      complete(attempt, response.status);
      return response;
    }, error => {
      complete(attempt, 0);
      throw error;
    });
  };
  const requests = new WeakSet<XMLHttpRequest>();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
    const result = (originalOpen as any).call(this, method, url, ...rest);
    if (method.toUpperCase() === 'PUT' && isPlaybackUrl(String(url))) requests.add(this);
    else requests.delete(this);
    return result;
  } as typeof originalOpen;
  XMLHttpRequest.prototype.send = function(body) {
    if (!requests.has(this)) return originalSend.call(this, body);
    const attempt = begin();
    const ended = () => complete(attempt, this.status);
    this.addEventListener('loadend', ended, { once: true });
    try { return originalSend.call(this, body); }
    catch (error) { this.removeEventListener('loadend', ended); complete(attempt, 0); throw error; }
  };
}

export function spotifyDiagnostics(common: any = (window.Vencord?.Webpack as any)?.Common) {
  const store = common?.SpotifyStore;
  if (!store) return { summary: 'Spotify has not initialized in Discord yet.' };
  const active = store.getActiveSocketAndDevice?.();
  const socket = active?.socket;
  const connected = store.hasConnectedAccount?.() === true;
  const realtime = socket?.socket?.readyState;
  const premium = typeof socket?.isPremium === 'boolean' ? socket.isPremium : undefined;
  const following = !!store.getSyncingWith?.();
  const play = latestPlay ? { ...latestPlay } : undefined;
  let advice = '';
  if (!connected) advice = 'Connect your Spotify account in Discord Connections.';
  else if (!active?.device || active.device.is_restricted) advice = 'Open Spotify and start a song on an available playback device, then try Listen Along again.';
  else if (premium === false) advice = 'Listen Along requires Spotify Premium on the listening account.';
  else if (play && Date.now() - play.at < 10 * 60_000) {
    if (play.status === 0) advice = 'The playback request failed before an HTTP response. Check the connection and try again.';
    else if (play.status === 401) advice = 'Spotify rejected authorization. Reconnect Spotify in Discord Connections.';
    else if (play.status === 403) advice = 'Spotify refused playback. Check Premium access and playback restrictions on the selected device.';
    else if (play.status === 404) advice = 'Spotify could not find the selected playback device. Start a song in Spotify, then retry.';
    else if (play.status === 429) advice = 'Spotify rate-limited playback requests. Wait before trying again.';
    else if (play.status >= 400) advice = 'Spotify returned a playback error. Try the same Listen Along in Discord’s web client to compare.';
    else if (play.status >= 200 && play.status < 300 && !following) advice = 'Spotify accepted the request, but the listening session is no longer active. Compare with Discord’s web client using the same Spotify device.';
  }
  const summary = [
    `Spotify account: ${connected ? 'connected' : 'not connected'}.`,
    `Active playback device: ${active?.device ? active.device.is_restricted ? 'restricted' : 'available' : 'none'}.`,
    `Realtime connection: ${realtime === 1 ? 'open' : realtime === 0 ? 'connecting' : realtime === 2 || realtime === 3 ? 'closed' : 'unknown'}.`,
    `Premium reported by Discord: ${premium === undefined ? 'unknown' : premium ? 'yes' : 'no'}.`,
    `Listen Along: ${following ? 'active' : 'inactive'}.`,
    play ? `Last playback request: ${play.status < 0 ? 'pending' : play.status === 0 ? 'network error' : `HTTP ${play.status}`}.` : 'No playback request recorded in this session.',
    advice, spotifyLocalStatus()?.message,
    spotifyLocalStatus()?.connected ? `Local player result: ${spotifyLocalStatus()?.outcome}.` : ''
  ].filter(Boolean).join(' ');
  return { connected, hasActiveDevice: !!active?.device, realtime, premium, following, play, summary };
}
