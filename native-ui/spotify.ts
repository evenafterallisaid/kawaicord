import { spotifyPlaybackCompleted, spotifyLocalStatus } from './spotify-local';
interface SpotifyRequest { endpoint: string; method: string; status: number; at: number }
const endpoints = new Set(['/v1/me/player', '/v1/me/player/play', '/v1/me/player/devices', '/v1/me/player/seek']);
let latestPlay: SpotifyRequest | undefined;
let installed = false;
let sequence = 0;

function endpointFor(input: string): string | undefined {
  try {
    const url = new URL(input, location.href);
    if (url.protocol === 'https:' && url.hostname === 'api.spotify.com' && url.port === '' && endpoints.has(url.pathname)) return url.pathname;
  } catch {}
}

// retain status codes only. tokens, account ids, track ids, and request bodies stay out.
export function installSpotifyDiagnostics() {
  if (installed) return;
  installed = true;
  const begin = (endpoint: string | undefined, method: string) => {
    if (endpoint !== '/v1/me/player/play' || method !== 'PUT') return 0;
    latestPlay = { endpoint, method, status: -1, at: Date.now() };
    return ++sequence;
  };
  const complete = (attempt: number, status: number) => {
    if (attempt) { if (attempt === sequence && latestPlay) latestPlay.status = status; spotifyPlaybackCompleted(); }
  };
  const originalFetch = window.fetch;
  window.fetch = async function(input, init) {
    const endpoint = endpointFor(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const attempt = begin(endpoint, method);
    try {
      const response = await originalFetch.call(this, input, init);
      complete(attempt, response.status);
      return response;
    } catch (error) {
      complete(attempt, 0);
      throw error;
    }
  };
  const requests = new WeakMap<XMLHttpRequest, { endpoint: string; method: string }>();
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(this: XMLHttpRequest, method: string, url: string | URL, ...rest: any[]) {
    const result = (originalOpen as any).call(this, method, url, ...rest);
    const endpoint = endpointFor(String(url));
    if (endpoint) requests.set(this, { endpoint, method: method.toUpperCase() });
    else requests.delete(this);
    return result;
  } as typeof originalOpen;
  XMLHttpRequest.prototype.send = function(body) {
    const request = requests.get(this);
    if (!request) return originalSend.call(this, body);
    const attempt = begin(request.endpoint, request.method);
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
