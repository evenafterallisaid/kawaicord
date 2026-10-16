export function nameplatePoster(source: string): string | undefined {
  try {
    const url = new URL(source);
    if (url.protocol !== 'https:' || url.hostname !== 'cdn.discordapp.com' || !url.pathname.startsWith('/assets/collectibles/nameplates/') || !url.pathname.endsWith('/asset.webm')) return;
    url.pathname = url.pathname.slice(0, -'asset.webm'.length) + 'static.png';
    return url.href;
  } catch { return; }
}

export function nameplateCompatibility() {
  let enabled = false;
  const posters = new Map<HTMLVideoElement, { image: HTMLImageElement; visibility: string; playing: boolean }>();
  function inspect(video: HTMLVideoElement) {
    if (!enabled) return;
    const source = video.src || video.querySelector('source')?.src || video.currentSrc || '';
    const poster = nameplatePoster(source);
    const previous = posters.get(video);
    if (!poster) { if (previous) { video.style.visibility = previous.visibility; previous.image.remove(); posters.delete(video); } return; }
    if (previous?.image.src === poster) return;
    previous?.image.remove();
    const image = document.createElement('img');
    image.alt = ''; image.className = video.className;
    image.style.cssText = video.style.cssText;
    image.style.position = 'absolute'; image.style.inset = '0'; image.style.width = '100%'; image.style.height = '100%';
    image.style.objectFit = 'cover'; image.style.pointerEvents = 'none'; image.dataset.kawaicordNameplate = '';
    const visibility = previous?.visibility ?? video.style.visibility;
    image.onload = () => { if (enabled && posters.get(video)?.image === image) { video.style.visibility = 'hidden'; video.pause(); } };
    image.onerror = () => {
      if (new URL(image.src).pathname.endsWith('/static.png')) { const fallback = new URL(image.src); fallback.pathname = fallback.pathname.replace(/\/static\.png$/, '/img.png'); image.src = fallback.href; }
      else { video.style.visibility = visibility; image.remove(); posters.delete(video); }
    };
    posters.set(video, { image, visibility, playing: previous?.playing ?? (!video.paused || video.autoplay) }); video.after(image); image.src = poster;
  }
  function scan(node: Node) {
    if (node instanceof HTMLVideoElement) inspect(node);
    if (node instanceof Element) for (const video of node.querySelectorAll('video')) inspect(video);
  }
  const observer = new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof HTMLVideoElement) inspect(record.target);
        else if (record.target instanceof HTMLSourceElement && record.target.parentElement instanceof HTMLVideoElement) inspect(record.target.parentElement);
      } else for (const node of record.addedNodes) scan(node);
    }
    for (const [video, state] of posters) if (!video.isConnected) { state.image.remove(); posters.delete(video); }
  });
  document.addEventListener('play', event => {
    if (enabled && event.target instanceof HTMLVideoElement && posters.has(event.target)) event.target.pause();
  }, true);
  return (value: boolean) => {
    enabled = value; observer.disconnect();
    if (value) { scan(document.documentElement); observer.observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] }); }
    else { for (const [video, state] of posters) { video.style.visibility = state.visibility; state.image.remove(); if (state.playing && video.isConnected) void video.play().catch(() => {}); } posters.clear(); }
  };
}
