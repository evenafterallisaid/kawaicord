export type ReloadShortcutInput = {
  type: string;
  key: string;
  control?: boolean;
  meta?: boolean;
  shift?: boolean;
  isAutoRepeat?: boolean;
};

export type RendererReloadRequest = {
  ignoreCache: boolean;
  reason: string;
};

export function getRendererReloadRequest(input: ReloadShortcutInput): RendererReloadRequest | null {
  if (input.type !== 'keyDown' || input.isAutoRepeat) return null;

  const key = input.key.toLowerCase();
  const reloadShortcut = Boolean((input.control || input.meta) && key === 'r');
  const reloadKey = key === 'f5';
  if (!reloadShortcut && !reloadKey) return null;

  const ignoreCache = Boolean(input.shift);
  return {
    ignoreCache,
    reason: ignoreCache ? 'hard refresh shortcut' : 'refresh shortcut'
  };
}
