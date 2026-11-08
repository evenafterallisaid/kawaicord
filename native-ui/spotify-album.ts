type Activity = {
  sync_id?: string;
  party?: { id?: string };
  metadata?: { album_id?: string };
};
type Action = { type: string; userId?: string; activity?: Activity };
type PlaybackRequest = {
  url: string;
  query?: { device_id?: string };
  body?: Record<string, unknown>;
};
type Stores = {
  SpotifyStore?: {
    getSyncingWith?: () => { userId: string; partyId: string } | null;
    getActiveSocketAndDevice?: () => { device?: { id: string; type: string; is_restricted?: boolean } } | null;
  };
  PresenceStore?: { getActivities?: (userId: string) => Activity[] | undefined };
};
type Shelter = {
  flux?: {
    storesFlat?: Stores;
    intercept?: (handler: (action: Action) => void) => () => void;
  };
  http?: {
    intercept?: (method: string, match: (url: string) => boolean,
      handler: (request: PlaybackRequest, send: (request: PlaybackRequest) => unknown) => unknown) => () => void;
  };
};

const spotifyId = /^[a-zA-Z0-9]{22}$/;
const trackUri = /^spotify:track:([a-zA-Z0-9]{22})$/;
const endpoint = 'https://api.spotify.com/v1/me/player/play';

export function installSpotifyAlbumContext(enabled: () => boolean) {
  const shelter = window.shelter as Shelter | undefined;
  if (!shelter?.flux?.intercept || !shelter.http?.intercept) return;
  let host: { userId: string; partyId: string; trackId?: string; albumId?: string; expires: number } | undefined;
  const stopFlux = shelter.flux.intercept(action => {
    if (action.type === 'ACTIVITY_SYNC') {
      const { userId, activity } = action;
      const partyId = activity?.party?.id;
      host = userId && partyId?.startsWith('spotify:')
        ? { userId, partyId, trackId: activity?.sync_id, albumId: activity?.metadata?.album_id, expires: Date.now() + 15_000 }
        : undefined;
    } else if (action.type === 'ACTIVITY_SYNC_STOP' || action.type === 'ACTIVITY_PLAY') {
      host = undefined;
    }
  });
  const stopHttp = shelter.http.intercept('put', url => url === endpoint, (request, send) => {
    const body = request.body;
    if (!enabled() || !host || !body || !Array.isArray(body.uris) || body.uris.length !== 1 ||
        body.context_uri != null || body.offset != null || typeof body.uris[0] !== 'string' ||
        typeof body.position_ms !== 'number' || !Number.isSafeInteger(body.position_ms) || body.position_ms < 0) {
      return send(request);
    }
    const match = trackUri.exec(body.uris[0]);
    if (!match) return send(request);
    const [uri, trackId] = match;
    const common = (window.Vencord?.Webpack as { Common?: Stores } | undefined)?.Common;
    const spotify = common?.SpotifyStore ?? shelter.flux?.storesFlat?.SpotifyStore;
    const presenceStore = common?.PresenceStore ?? shelter.flux?.storesFlat?.PresenceStore;
    const device = spotify?.getActiveSocketAndDevice?.()?.device;
    if (device?.type !== 'Computer' || device.is_restricted || device.id !== request.query?.device_id) {
      return send(request);
    }
    const sync = spotify?.getSyncingWith?.();
    // the first play request can run before discord publishes its syncing state.
    const initial = host.expires > Date.now() && host.trackId === trackId;
    if (!initial && sync?.userId !== host.userId) return send(request);
    const partyId = initial ? host.partyId : sync?.partyId;
    const presence = presenceStore?.getActivities?.(host.userId)
      ?.find(activity => activity.sync_id === trackId && activity.party?.id === partyId);
    const albumId = presence?.metadata?.album_id ?? (initial ? host.albumId : undefined);
    if (typeof albumId !== 'string' || !spotifyId.test(albumId)) return send(request);
    const { uris: _uris, ...options } = body;
    return send({
      ...request,
      body: { ...options, context_uri: `spotify:album:${albumId}`, offset: { uri } }
    });
  });
  window.addEventListener('pagehide', () => { stopFlux(); stopHttp(); host = undefined; }, { once: true });
}
