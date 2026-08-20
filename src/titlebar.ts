export const TITLEBAR_FALLBACK_HEIGHT = 32;
export const TITLEBAR_CONTROLS_WIDTH = 138;
export const TITLEBAR_CONTROLS_GAP = 8;
export const TITLEBAR_RESERVED_WIDTH = TITLEBAR_CONTROLS_WIDTH + TITLEBAR_CONTROLS_GAP;

// These rules only protect the part of Discord that shares space with the
// frameless window controls. Runtime inline locks provide the final authority;
// the stylesheet keeps the layout correct before Discord's app bar mounts.
export const KAWAICORD_TITLEBAR_CSS = `
  html:root:root:root {
    --custom-app-top-bar-height: ${TITLEBAR_FALLBACK_HEIGHT}px !important;
    --kawaicord-titlebar-height: ${TITLEBAR_FALLBACK_HEIGHT}px !important;
    --kawaicord-window-controls-width: ${TITLEBAR_CONTROLS_WIDTH}px !important;
    --kawaicord-window-controls-reserved-width: ${TITLEBAR_RESERVED_WIDTH}px !important;
  }

  html:root body[customTitlebar][kawaicord-platform] div[class*="title"] + div[class*="trailing"] {
    margin-inline-end: var(--kawaicord-window-controls-reserved-width) !important;
    margin-right: var(--kawaicord-window-controls-reserved-width) !important;
  }

  html:root body[customTitlebar][kawaicord-platform] div[class*="title"]:has(+ div[class*="trailing"]) {
    -webkit-app-region: drag !important;
  }

  html:root body[customTitlebar][kawaicord-platform] div[class*="title"]:has(+ div[class*="trailing"]) button,
  html:root body[customTitlebar][kawaicord-platform] div[class*="title"]:has(+ div[class*="trailing"]) a,
  html:root body[customTitlebar][kawaicord-platform] div[class*="title"]:has(+ div[class*="trailing"]) input,
  html:root body[customTitlebar][kawaicord-platform] div[class*="title"]:has(+ div[class*="trailing"]) [role="button"],
  html:root body[customTitlebar][kawaicord-platform] div[class*="trailing"] {
    -webkit-app-region: no-drag !important;
  }
`;

// The actual controls live in a shadow root. Theme variables still inherit,
// while selectors and global resets from third-party themes cannot enter it.
export const KAWAICORD_WINDOW_CONTROLS_CSS = `
  :host {
    color: var(--interactive-icon-default, var(--interactive-normal, #b5bac1));
    background-color: var(--background-base-lowest, var(--background-tertiary, #111214));
    font-family: var(--font-primary, "gg sans", "Segoe UI", sans-serif);
    -webkit-app-region: no-drag;
    user-select: none;
  }

  *, *::before, *::after {
    box-sizing: border-box;
  }

  .controls {
    display: flex;
    width: 100%;
    height: 100%;
    color: inherit;
    background: inherit;
  }

  button {
    all: unset;
    position: relative;
    display: grid;
    width: 46px;
    height: 100%;
    flex: 0 0 46px;
    place-items: center;
    color: inherit;
    background: transparent;
    cursor: default;
    transition: color 100ms ease, background-color 100ms ease;
  }

  button:hover {
    color: var(--interactive-text-hover, var(--header-primary, #f2f3f5));
    background-color: var(--interactive-background-hover, rgba(255, 255, 255, 0.08));
  }

  button:focus-visible {
    outline: 2px solid var(--focus-primary, var(--brand-500, #5865f2));
    outline-offset: -2px;
  }

  button.close:hover {
    color: #fff;
    background-color: #e81123;
  }

  .icon {
    position: relative;
    width: 10px;
    height: 10px;
    pointer-events: none;
  }

  .minimize::before {
    position: absolute;
    inset: auto 0 1px;
    height: 1px;
    background: currentColor;
    content: "";
  }

  .maximize::before {
    position: absolute;
    inset: 0;
    border: 1px solid currentColor;
    content: "";
  }

  :host([data-maximized="true"]) .maximize::before,
  :host([data-maximized="true"]) .maximize::after {
    position: absolute;
    width: 7px;
    height: 7px;
    border: 1px solid currentColor;
    content: "";
  }

  :host([data-maximized="true"]) .maximize::before {
    inset: 2px auto auto 0;
  }

  :host([data-maximized="true"]) .maximize::after {
    inset: 0 0 auto auto;
    background-color: var(--background-base-lowest, var(--background-tertiary, #111214));
  }

  .close-icon::before,
  .close-icon::after {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 12px;
    height: 1px;
    background: currentColor;
    content: "";
  }

  .close-icon::before {
    transform: translate(-50%, -50%) rotate(45deg);
  }

  .close-icon::after {
    transform: translate(-50%, -50%) rotate(-45deg);
  }

  @media (forced-colors: active) {
    button:hover {
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
