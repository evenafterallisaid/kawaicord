import type { Invoke } from './discord-settings';
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


interface ChromeState { maximized: boolean; focused: boolean }
export function installTitlebar(invoke: Invoke) {
  const style = document.createElement('style');
  style.textContent = `
    :root { --custom-app-top-bar-height:32px!important; }
    #kawaicord-window-controls { position:fixed!important;inset:0 0 auto auto!important;width:138px!important;height:32px!important;z-index:2147483646!important;isolation:isolate;contain:layout style; }
    #kawaicord-titlebar-drag-region { position:fixed;top:0;left:80px;right:250px;height:32px;z-index:2147483644;user-select:none;-webkit-app-region:drag;app-region:drag; }
    body[customTitlebar] div[class*="title"] + div[class*="trailing"] { margin-inline-end:146px!important; }
    @media (display-mode:fullscreen) { #kawaicord-window-controls,#kawaicord-titlebar-drag-region { display:none!important; } }
  `;
  document.head.append(style);
  document.body.setAttribute('customTitlebar', '');
  const host = document.createElement('div');
  host.id = 'kawaicord-window-controls'; host.setAttribute('role', 'group'); host.setAttribute('aria-label', 'Window controls');
  const shadow = host.attachShadow({ mode: 'open' });
  const sheet = document.createElement('style'); sheet.textContent = KAWAICORD_WINDOW_CONTROLS_CSS;
  const controls = document.createElement('div'); controls.className = 'controls';
  controls.innerHTML = `<button type="button" aria-label="Minimize" title="Minimize"><span class="icon minimize"></span></button><button type="button" aria-label="Maximize" title="Maximize"><span class="icon maximize"></span></button><button type="button" aria-label="Close" title="Close" class="close"><span class="icon close-icon"></span></button>`;
  shadow.append(sheet, controls);
  const drag = document.createElement('div'); drag.id = 'kawaicord-titlebar-drag-region'; drag.setAttribute('aria-hidden', 'true');
  document.body.append(drag, host);
  const buttons = Array.from(controls.querySelectorAll('button'));
  function apply(state: ChromeState) {
    host.dataset.maximized = String(state.maximized); host.dataset.focused = String(state.focused);
    const label = state.maximized ? 'Restore' : 'Maximize'; buttons[1].title = label; buttons[1].setAttribute('aria-label', label);
  }
  (window as any).__kawaicordWindowState = apply;
  const action = (action: string) => invoke<ChromeState>('window_action', { action }).then(apply).catch(console.error);
  buttons[0].onclick = () => void action('minimize');
  buttons[1].onclick = () => void action('maximize');
  buttons[2].onclick = () => void action('close');
  drag.onmousedown = event => { if (event.button === 0 && event.detail === 1) void action('drag'); };
  drag.ondblclick = () => void action('maximize');
  void action('state');
  let bar: HTMLElement | undefined;
  let pending = false;
  const size = new ResizeObserver(() => schedule());
  function layout() {
    pending = false;
    if (document.hidden) return;
    if (!bar?.isConnected) {
      bar = Array.from(document.querySelectorAll<HTMLElement>('div[class*="title"] + div[class*="trailing"]'))
        .find(element => element.parentElement!.getBoundingClientRect().top < 64)?.parentElement ?? undefined;
      size.disconnect(); if (bar) size.observe(bar);
    }
    const trailing = bar?.querySelector<HTMLElement>(':scope > div[class*="trailing"]');
    const right = trailing ? Math.max(146, Math.round(innerWidth - trailing.getBoundingClientRect().left + 8)) : 250;
    drag.style.right = `${right}px`;
  }
  function schedule() { if (!pending && !document.hidden) { pending = true; requestAnimationFrame(layout); } }
  // normal chat updates do not trigger layout work once the app bar is mounted.
  const mount = new MutationObserver(() => { if (!bar?.isConnected) schedule(); });
  mount.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', schedule);
  document.addEventListener('visibilitychange', schedule);
  window.addEventListener('pagehide', () => { mount.disconnect(); size.disconnect(); }, { once: true });
  schedule();
}
