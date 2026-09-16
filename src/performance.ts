export function shouldReleaseImageCache(size: number, liveSize: number, mediaPlaying: boolean): boolean {
  // Avoid turning ordinary tray restores into costly image re-decodes.
  return !mediaPlaying && Number.isFinite(size) && Number.isFinite(liveSize)
    && liveSize >= 0 && size - liveSize >= 64 * 1024 * 1024
    && liveSize <= size / 2;
}
