export const TITLEBAR_FALLBACK_HEIGHT = 32;

export const KAWAICORD_TITLEBAR_CSS = `
  :root {
    --kawaicord-titlebar-height: var(--custom-app-top-bar-height, ${TITLEBAR_FALLBACK_HEIGHT}px);
  }

  .kawaicord-titlebar {
    position: fixed;
    inset: 0 0 auto 0;
    z-index: 2147483646;
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    height: var(--kawaicord-titlebar-height);
    box-sizing: border-box;
    overflow: hidden;
    color: var(--interactive-icon-default, var(--interactive-normal, #b5bac1));
    background-color: var(--background-base-lowest, var(--background-tertiary, #111214));
    border-bottom: 1px solid var(--border-subtle, transparent);
    font-family: var(--font-primary, "gg sans", "Segoe UI", sans-serif);
    -webkit-app-region: drag;
    user-select: none;
  }

  .kawaicord-title {
    display: flex;
    align-items: center;
    min-width: 0;
    height: 100%;
    gap: 7px;
    padding: 0 12px;
    color: var(--header-secondary, var(--text-muted, #b5bac1));
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.01em;
    white-space: nowrap;
  }

  .kawaicord-title-mark {
    color: var(--brand-500, var(--brand-experiment, #5865f2));
    font-size: 13px;
    line-height: 1;
  }

  .kawaicord-controls {
    display: flex;
    align-self: stretch;
    flex: 0 0 auto;
    -webkit-app-region: no-drag;
  }

  .kawaicord-control {
    position: relative;
    display: grid;
    width: 46px;
    height: 100%;
    place-items: center;
    padding: 0;
    color: inherit;
    background: transparent;
    border: 0;
    cursor: default;
    transition: color 100ms ease, background-color 100ms ease;
  }

  .kawaicord-control:hover {
    color: var(--interactive-text-hover, var(--header-primary, #f2f3f5));
    background-color: var(--interactive-background-hover, rgba(255, 255, 255, 0.08));
  }

  .kawaicord-control:focus-visible {
    outline: 2px solid var(--focus-primary, var(--brand-500, #5865f2));
    outline-offset: -2px;
  }

  .kawaicord-control.close:hover {
    color: #fff;
    background-color: #e81123;
  }

  .kawaicord-control-icon {
    position: relative;
    width: 10px;
    height: 10px;
    pointer-events: none;
  }

  .kawaicord-icon-minimize::before {
    position: absolute;
    inset: auto 0 1px;
    height: 1px;
    background: currentColor;
    content: "";
  }

  .kawaicord-icon-maximize::before {
    position: absolute;
    inset: 0;
    border: 1px solid currentColor;
    content: "";
  }

  body[data-kawaicord-maximized="true"] .kawaicord-icon-maximize::before,
  body[data-kawaicord-maximized="true"] .kawaicord-icon-maximize::after {
    position: absolute;
    width: 7px;
    height: 7px;
    border: 1px solid currentColor;
    content: "";
  }

  body[data-kawaicord-maximized="true"] .kawaicord-icon-maximize::before {
    inset: 2px auto auto 0;
  }

  body[data-kawaicord-maximized="true"] .kawaicord-icon-maximize::after {
    inset: 0 0 auto auto;
    background-color: var(--background-base-lowest, var(--background-tertiary, #111214));
  }

  .kawaicord-icon-close::before,
  .kawaicord-icon-close::after {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 12px;
    height: 1px;
    background: currentColor;
    content: "";
  }

  .kawaicord-icon-close::before {
    transform: translate(-50%, -50%) rotate(45deg);
  }

  .kawaicord-icon-close::after {
    transform: translate(-50%, -50%) rotate(-45deg);
  }

  #app-mount {
    position: fixed !important;
    inset: var(--kawaicord-titlebar-height) 0 0 !important;
    width: auto !important;
    height: auto !important;
  }

  @media (forced-colors: active) {
    .kawaicord-titlebar {
      border-bottom-color: CanvasText;
    }

    .kawaicord-control:hover {
      color: HighlightText;
      background-color: Highlight;
    }
  }
`;

export function cssRgbToHex(value: string): string | null {
  const match = value.trim().match(/^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)/i);
  if (!match) return null;

  const channels = match.slice(1, 4).map(channel => {
    const normalized = Math.max(0, Math.min(255, Math.round(Number(channel))));
    return normalized.toString(16).padStart(2, '0');
  });

  return `#${channels.join('')}`;
}
