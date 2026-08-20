export type ClientMod = 'vencord' | 'equicord';

export type PatchedClientModBundle = {
  source: string;
  restartHooks: number;
};

// Browser builds use page reloads for their restart buttons. In Kawaicord that
// tears down only the renderer, so route those calls through the full app
// restart bridge exposed by preload instead.
const clientModRestartCall = /(^|[^\w$.])(?:window\s*\.\s*)?location\s*\.\s*reload\s*\(\s*\)/gm;

export function routeClientModRestarts(source: string): PatchedClientModBundle {
  let restartHooks = 0;
  const patchedSource = source.replace(clientModRestartCall, (_match, prefix: string) => {
    restartHooks += 1;
    return `${prefix}window.kawaicord.restart()`;
  });

  return {
    source: patchedSource,
    restartHooks
  };
}
