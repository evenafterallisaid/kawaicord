import type { Invoke } from './discord-settings';
export interface SpotifyBridgeStatus { connected: boolean; outcome: string; message: string }
let invoke: Invoke | undefined, enabled = false, installed = false, session = '', generation = 0;
let timer: ReturnType<typeof setTimeout> | undefined, previous = '', wasFollowing = false;
let deadline = 0, needsRestart = false, presenceSignature = '';
let lastStatus: SpotifyBridgeStatus | undefined;
let hostPresenceObserved = false;
const common = () => (window.Vencord?.Webpack as any)?.Common;
async function command(request: Record<string, unknown>) {
  if (!invoke) return;
  try { return lastStatus = await invoke<SpotifyBridgeStatus>('spotify_bridge', { request }); }
  catch (error) { lastStatus = { connected: false, outcome: 'error', message: String(error) }; }
}
function publish(restart = false) {
  if (!enabled) return;
  const store = common()?.SpotifyStore, sync = store?.getSyncingWith?.();
  if (!sync) return;
  const socket = store.getActiveSocketAndDevice?.()?.socket;
  if (socket?.isPremium !== true || !/^[a-zA-Z0-9]{22}$/.test(sync.trackId) || !Number.isSafeInteger(sync.startTime)) return;
  const activity = common()?.PresenceStore?.getActivities?.(sync.userId)?.find((value: any) => value.sync_id === sync.trackId);
  if (activity) hostPresenceObserved = true;
  if (activity?.metadata?.type && activity.metadata.type !== 'track') return;
  const duration = activity?.timestamps?.end - activity?.timestamps?.start;
  const snapshot = { session, uri: `spotify:track:${sync.trackId}`, startMs: sync.startTime, durationMs: Number.isSafeInteger(duration) && duration > 0 && duration <= 3_600_000 ? duration : 0, paused: hostPresenceObserved && !activity };
  const serialized = JSON.stringify(snapshot);
  if (!restart && serialized === previous) return;
  previous = serialized; void command({ action: 'publish', snapshot, restart });
}
function schedule(delay: number, restart = false) {
  needsRestart ||= restart;
  const due = Date.now() + delay;
  if (timer && deadline <= due) return;
  if (timer) clearTimeout(timer);
  deadline = due; timer = setTimeout(() => { timer = undefined; deadline = 0; const force = needsRestart; needsRestart = false; publish(force); }, delay);
}
export function spotifyPlaybackCompleted() { if (enabled && common()?.SpotifyStore?.getSyncingWith?.()) schedule(150, true); }
export function spotifyLocalStatus() { return lastStatus; }
export async function refreshSpotifyLocal() { if (enabled) await command({ action: 'status' }); }
export function configureSpotifyLocal(value: boolean) {
  const changed = value !== enabled;
  enabled = value; previous = '';
  if (!value && timer) { clearTimeout(timer); timer = undefined; }
  if (invoke && (value || changed)) void command({ action: value ? 'status' : 'stop' });
}
export function installSpotifyLocal(bridge: Invoke, value: boolean) {
  invoke = bridge;
  // a freshly loaded discord page must not inherit ownership from its previous session.
  if (value) void command({ action: 'stop' });
  configureSpotifyLocal(value);
  const stores = common();
  if (installed || typeof stores?.SpotifyStore?.addChangeListener !== 'function' || typeof stores?.FluxDispatcher?.subscribe !== 'function') return;
  installed = true;
  window.addEventListener?.('pagehide', () => configureSpotifyLocal(false), { once: true });
  const started = () => { session = `${Date.now()}-${++generation}`; previous = ''; hostPresenceObserved = false; presenceSignature = ''; if (enabled) schedule(1000, true); };
  stores.FluxDispatcher.subscribe('ACTIVITY_SYNC', started);
  stores.PresenceStore?.addChangeListener?.(() => {
    const sync = stores.SpotifyStore.getSyncingWith?.();
    if (!enabled || !sync) return;
    const activity = stores.PresenceStore.getActivities(sync.userId)?.find((value: any) => value.sync_id === sync.trackId);
    const signature = JSON.stringify([activity?.sync_id, activity?.timestamps?.start, activity?.timestamps?.end]);
    if (signature !== presenceSignature) { presenceSignature = signature; schedule(1500); }
  });
  stores.SpotifyStore.addChangeListener(() => {
    const following = !!stores.SpotifyStore.getSyncingWith?.();
    if (following && !wasFollowing && !session) started();
    if (!following && wasFollowing) { session = ''; previous = ''; if (timer) clearTimeout(timer); if (enabled) void command({ action: 'stop' }); }
    wasFollowing = following;
  });
  (window as any).__kawaicordSpotifyStop = () => { if (stores.SpotifyStore.getSyncingWith?.()) stores.FluxDispatcher.dispatch({ type: 'ACTIVITY_SYNC_STOP' }); };
}
