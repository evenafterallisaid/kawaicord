export const TITLEBAR_FALLBACK_HEIGHT = 32;
export const TITLEBAR_CONTROLS_WIDTH = 138;

export const KAWAICORD_TITLEBAR_CSS = `
  :root {
    --kawaicord-titlebar-height: max(${TITLEBAR_FALLBACK_HEIGHT}px, var(--custom-app-top-bar-height, 0px));
    --kawaicord-window-controls-width: ${TITLEBAR_CONTROLS_WIDTH}px;
  }

  /* Discord already renders its own app bar. Keep it in place and reserve the
   * right edge for our frameless-window controls, matching Legcord's layout. */
  body[customTitlebar] div[class*="title"] + div[class*="trailing"] {
    margin-right: var(--kawaicord-window-controls-width) !important;
  }

  body[customTitlebar] div[class*="title"]:has(+ div[class*="trailing"]) {
    -webkit-app-region: drag;
  }

  body[customTitlebar] div[class*="title"]:has(+ div[class*="trailing"]) button,
  body[customTitlebar] div[class*="title"]:has(+ div[class*="trailing"]) a,
  body[customTitlebar] div[class*="title"]:has(+ div[class*="trailing"]) input,
  body[customTitlebar] div[class*="title"]:has(+ div[class*="trailing"]) [role="button"],
  body[customTitlebar] div[class*="trailing"] {
    -webkit-app-region: no-drag;
  }

  .kawaicord-controls {
    position: fixed;
    inset: 0 0 auto auto;
    z-index: 2147483646;
    display: flex;
    width: var(--kawaicord-window-controls-width);
    height: var(--kawaicord-titlebar-height);
    color: var(--interactive-icon-default, var(--interactive-normal, #b5bac1));
    background-color: var(--background-base-lowest, var(--background-tertiary, #111214));
    font-family: var(--font-primary, "gg sans", "Segoe UI", sans-serif);
    -webkit-app-region: no-drag;
    user-select: none;
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

  @media (forced-colors: active) {
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
