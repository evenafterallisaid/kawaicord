import type { Invoke } from './discord-settings';

export function installExternalLinks(invoke: Invoke) {
  function clicked(event: MouseEvent) {
    if (!event.isTrusted || event.defaultPrevented || (event.type === 'click' ? event.button !== 0 : event.button !== 1)) return;
    const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined;
    if (!anchor || anchor.hasAttribute('download')) return;
    let url: URL;
    try { url = new URL(anchor.href, location.href); } catch { return; }
    if (!['http:', 'https:', 'mailto:', 'spotify:'].includes(url.protocol) || url.origin === location.origin) return;
    event.preventDefault();
    void invoke('open_link', { url: url.href }).catch(console.error);
  }
  // bubble after discord's own handlers so its link warnings and plugin actions still work.
  document.addEventListener('click', clicked);
  document.addEventListener('auxclick', clicked);
}
