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
    app-region: drag !important;
    -webkit-app-region: drag !important;
  }

  html:root body[customTitlebar][kawaicord-platform] div[class*="title"]:has(+ div[class*="trailing"])::before {
    content: "";
    position: fixed;
    inset: 0 146px auto 80px;
    height: ${TITLEBAR_FALLBACK_HEIGHT}px;
    app-region: drag !important;
    -webkit-app-region: drag !important;
    pointer-events: none;
  }

  html:root body[customTitlebar][kawaicord-platform] div[class*="title"]:has(+ div[class*="trailing"]) button,
  html:root body[customTitlebar][kawaicord-platform] div[class*="title"]:has(+ div[class*="trailing"]) a,
  html:root body[customTitlebar][kawaicord-platform] div[class*="title"]:has(+ div[class*="trailing"]) input,
  html:root body[customTitlebar][kawaicord-platform] div[class*="title"]:has(+ div[class*="trailing"]) [role="button"],
  html:root body[customTitlebar][kawaicord-platform] div[class*="trailing"] {
    app-region: no-drag !important;
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

  .navigation {
    display: flex;
    width: 80px;
    height: 100%;
    align-items: center;
    padding-left: 4px;
    color: inherit;
    background: inherit;
  }

  .navigation button {
    width: 36px;
    flex: 0 0 36px;
  }

  .navigation button:disabled {
    color: var(--interactive-muted, #5c6068);
    pointer-events: none;
  }

  :host([data-focused="false"]) .controls {
    color: var(--interactive-muted, var(--interactive-normal, #80848e));
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
    transition: color 80ms linear, background-color 80ms linear;
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

  button:not(.close):active {
    color: var(--interactive-text-active, var(--header-primary, #f2f3f5));
    background-color: var(--interactive-background-selected, rgba(255, 255, 255, 0.12));
  }

  button.close:active {
    color: rgba(0, 0, 0, 0.8);
    background-color: #f1707a;
  }

  .icon {
    width: 11px;
    height: 11px;
    background-color: currentColor;
    -webkit-mask-position: center;
    -webkit-mask-repeat: no-repeat;
    -webkit-mask-size: 11px 11px;
    pointer-events: none;
  }

  .minimize {
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 11 11'%3E%3Cpath d='M0 5h11v1H0z'/%3E%3C/svg%3E");
  }

  .maximize {
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 11 11'%3E%3Cpath fill-rule='evenodd' d='M0 0h11v11H0V0zm1 1v9h9V1H1z'/%3E%3C/svg%3E");
  }

  :host([data-maximized="true"]) .maximize {
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 11 11'%3E%3Cpath fill-rule='evenodd' d='M3 0h8v8H9V3H3V0zm1 1v1h6v5H9V1H4zM0 3h8v8H0V3zm1 1v6h6V4H1z'/%3E%3C/svg%3E");
  }

  .close-icon {
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 11 11'%3E%3Cpath d='M.78 0 5.5 4.72 10.22 0l.78.78L6.28 5.5 11 10.22l-.78.78L5.5 6.28.78 11 0 10.22 4.72 5.5 0 .78.78 0z'/%3E%3C/svg%3E");
  }

  .back-icon {
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 11 11'%3E%3Cpath d='M4.32.78 0 5.1l4.32 4.32.78-.78L2.11 5.65H11v-1.1H2.11L5.1 1.56 4.32.78z'/%3E%3C/svg%3E");
  }

  .forward-icon {
    -webkit-mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 11 11'%3E%3Cpath d='m6.68.78 4.32 4.32-4.32 4.32-.78-.78 2.99-2.99H0v-1.1h8.89L5.9 1.56l.78-.78z'/%3E%3C/svg%3E");
  }

  @media (prefers-reduced-motion: reduce) {
    button {
      transition: none;
    }
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
