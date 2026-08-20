import { ipcRenderer, webFrame } from 'electron';
import { routeClientModRestarts } from './mod-patches';
import {
  cssRgbToHex,
  KAWAICORD_TITLEBAR_CSS,
  KAWAICORD_WINDOW_CONTROLS_CSS,
  TITLEBAR_CONTROLS_WIDTH,
  TITLEBAR_FALLBACK_HEIGHT,
  TITLEBAR_RESERVED_WIDTH
} from './titlebar';

type ActiveMod = 'vencord' | 'equicord';

type KawaicordConfig = {
  activeMod: ActiveMod;
  performanceMode: boolean;
  backgroundThrottling: boolean;
  arRPC: boolean;
  trayEnabled: boolean;
  trayIconAuto: boolean;
  trayIconTheme: 'dark' | 'light';
  startAtLogin: boolean;
  minimizeToTray: boolean;
  autoUpdateMods: boolean;
};

const defaultConfig: KawaicordConfig = {
  activeMod: 'vencord',
  performanceMode: true,
  backgroundThrottling: false,
  arRPC: true,
  trayEnabled: true,
  trayIconAuto: true,
  trayIconTheme: 'dark',
  startAtLogin: false,
  minimizeToTray: false,
  autoUpdateMods: true
};

(window as any).kawaicord = {
  version: async () => await ipcRenderer.invoke('kawaicord:getVersion'),
  reload: async () => await ipcRenderer.invoke('kawaicord:reload'),
  restart: async () => await ipcRenderer.invoke('kawaicord:restart'),
  getConfig: async () => await ipcRenderer.invoke('kawaicord:getConfig'),
  getRuntimeStatus: async () => await ipcRenderer.invoke('kawaicord:getRuntimeStatus'),
  setConfig: async (config: Partial<KawaicordConfig>) => await ipcRenderer.invoke('kawaicord:setConfig', config),
  setTrayIcon: (theme: 'dark' | 'light') => ipcRenderer.send('kawaicord:setTrayIcon', theme),
  toggleTray: (enabled: boolean) => ipcRenderer.send('kawaicord:toggleTray', enabled),
  platform: process.platform,
  isKawaicord: true,
  electron: process.versions.electron || '',
  rpc: {
    listen: (callback: (data: any) => void) => {
      ipcRenderer.on('rpc', (_event, data) => callback(data));
    },
    refreshProcessList: () => ipcRenderer.send('kawaicord:rpc:refreshProcessList'),
    getProcessList: () => ipcRenderer.sendSync('kawaicord:rpc:getProcessList'),
    addDetectable: (detectable: any) => ipcRenderer.send('kawaicord:rpc:addDetectable', detectable),
    getDetectables: () => ipcRenderer.sendSync('kawaicord:rpc:getDetectables')
  }
};

console.log('Kawaicord preload ready.');

function injectPageScript(source: string) {
  const script = document.createElement('script');
  script.textContent = source;

  const mount = () => {
    (document.documentElement || document.head || document.body)?.prepend(script);
  };

  if (document.documentElement || document.head || document.body) {
    mount();
    return;
  }

  const observer = new MutationObserver(() => {
    if (document.documentElement || document.head || document.body) {
      observer.disconnect();
      mount();
    }
  });

  observer.observe(document, { childList: true, subtree: true });
}

function injectCompatibilityPatches() {
  injectPageScript(`(() => {
    try {
      window.localStorage?.setItem("hideNag", "true");
    } catch {}

    if (window.PublicKeyCredential) {
      try {
        Object.defineProperty(PublicKeyCredential, "isConditionalMediationAvailable", {
          value: async () => false,
          writable: true,
          configurable: true
        });
        Object.defineProperty(PublicKeyCredential, "getClientCapabilities", {
          value: async () => ({}),
          writable: true,
          configurable: true
        });
      } catch {}
    }
  })();`);
}

async function injectMod() {
  const injectionStatus = {
    shelter: false,
    mod: null as ActiveMod | null,
    restartHooks: 0,
    error: null as string | null
  };
  (window as any).kawaicordInjectionStatus = injectionStatus;

  try {
    try {
      const shelterBundle = await ipcRenderer.invoke('kawaicord:getShelterBundle') as { js?: string };
      if (shelterBundle?.js) {
        await webFrame.executeJavaScript(`(()=>{
  const SHELTER_INJECTOR_PLUGINS = {
    "kawaicord-settings": [
      "kawaicord://plugins/settings/",
      { isVisible: false, allowedActions: {} }
    ]
  };

  const KawaicordSettingsPage = () => {
    const container = document.createElement('div');

    if (typeof window.kawaicordRenderSettingsPage === 'function') {
      window.kawaicordRenderSettingsPage(container);
    } else {
      container.textContent = 'Kawaicord settings renderer unavailable.';
      container.style.padding = '16px';
      container.style.color = 'var(--text-normal, #fff)';
    }

    return container;
  };

  const SHELTER_INJECTOR_SETTINGS = [
    ['divider'],
    ['header', 'Kawaicord'],
    ['section', 'kawaicord-settings', 'Settings', KawaicordSettingsPage]
  ];

  ${shelterBundle.js}
})()`);
        console.log('Shelter JS injected');
        injectionStatus.shelter = true;
      } else {
        throw new Error('Shelter bundle was empty');
      }
    } catch (e) {
      console.error('Failed to inject Shelter:', e);
      injectionStatus.error = `Shelter failed: ${e instanceof Error ? e.message : String(e)}`;
    }

    const runtime = await ipcRenderer.invoke('kawaicord:getRuntimeStatus') as {
      activeMod: ActiveMod;
      safeMode: boolean;
    };

    if (runtime.safeMode) {
      console.warn('Recovery mode is active; Shelter loaded without Vencord or Equicord.');
      return;
    }

    const channel = runtime.activeMod === 'equicord'
      ? 'kawaicord:getEquicordBundle'
      : 'kawaicord:getVencordBundle';
    const bundle = await ipcRenderer.invoke(channel) as {
      enabled?: boolean;
      mod?: ActiveMod;
      js?: string;
      css?: string;
    };

    if (!bundle?.enabled || !bundle.js) {
      throw new Error(`${runtime.activeMod} is active but its JavaScript bundle is unavailable`);
    }

    const patchedBundle = routeClientModRestarts(bundle.js);
    injectionStatus.restartHooks = patchedBundle.restartHooks;
    if (patchedBundle.restartHooks === 0) {
      console.warn(`${runtime.activeMod} exposed no page-reload restart calls to route.`);
    } else {
      console.log(`Routed ${patchedBundle.restartHooks} ${runtime.activeMod} restart calls through Kawaicord.`);
    }

    await webFrame.executeJavaScript(`${patchedBundle.source}\n//# sourceURL=kawaicord-${runtime.activeMod}.js`);
    if (bundle.css) await webFrame.insertCSS(bundle.css);
    injectionStatus.mod = runtime.activeMod;
    console.log(`${runtime.activeMod} injected`);
  } catch (error) {
    console.error('Failed to inject mod:', error);
    injectionStatus.error = error instanceof Error ? error.message : String(error);
  } finally {
    ipcRenderer.send('kawaicord:injectionStatus', injectionStatus);
  }
}

async function renderSettingsPage(targetContainer?: HTMLElement) {
  const container = targetContainer;
  if (!container) {
    return;
  }

  const rawConfig = await (window as any).kawaicord.getConfig() as Partial<KawaicordConfig>;
  const config: KawaicordConfig = { ...defaultConfig, ...rawConfig };
  const runtime = await (window as any).kawaicord.getRuntimeStatus() as {
    activeMod: ActiveMod;
    safeMode: boolean;
    logPath: string;
  };

  const modOptions: { value: ActiveMod; label: string }[] = [
    { value: 'vencord', label: 'Vencord' },
    { value: 'equicord', label: 'Equicord' }
  ];
  const currentModLabel = modOptions.find(o => o.value === config.activeMod)?.label ?? 'Vencord';
  let selectedMod = config.activeMod;

  container.className = 'kawaicord-settings-page';
  container.innerHTML = `
    <div class="kawaicord-hero">
      <div>
        <div class="kawaicord-header">Kawaicord</div>
        <div class="kawaicord-subtitle">A polished home for Discord, Shelter, and your preferred client mod.</div>
      </div>
      <div class="kawaicord-status${runtime.safeMode ? ' recovery' : ''}">
        <span class="kawaicord-status-dot"></span>
        ${runtime.safeMode ? 'Recovery mode' : `${currentModLabel} active`}
      </div>
    </div>

    ${runtime.safeMode ? `
      <div class="kawaicord-recovery-notice">
        Shelter is still active. Vencord and Equicord are paused for this session because Kawaicord detected an unclean exit or repeated renderer failure. A normal restart will try ${currentModLabel} again.
      </div>
    ` : ''}

    <div id="kawaicord-restart-banner" class="kawaicord-restart-banner" style="display:none">
      <div class="kawaicord-restart-banner-content">
        <svg class="kawaicord-restart-banner-icon" width="20" height="20" viewBox="0 0 24 24" fill="none">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15v-2h2v2h-2zm0-4V7h2v6h-2z" fill="currentColor"/>
        </svg>
        <span class="kawaicord-restart-banner-text">Client mod changed. Restart Kawaicord to apply changes.</span>
      </div>
      <div class="kawaicord-restart-banner-actions">
        <button type="button" class="kawaicord-banner-btn kawaicord-banner-btn-ignore" id="kawaicord-banner-ignore">Ignore</button>
        <button type="button" class="kawaicord-banner-btn kawaicord-banner-btn-restart" id="kawaicord-banner-restart">Restart</button>
      </div>
    </div>

    <div class="kawaicord-section">
      <div class="kawaicord-option">
        <div>
          <div class="kawaicord-option-label">Active Mod</div>
          <div class="kawaicord-option-desc">Choose which client mod to load.</div>
        </div>
        <div class="kawaicord-dropdown" id="kawaicord-mod-dropdown">
          <button class="kawaicord-dropdown-trigger" id="kawaicord-dropdown-trigger" type="button">
            <span class="kawaicord-dropdown-value">${currentModLabel}</span>
            <svg class="kawaicord-dropdown-chevron" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 10l5 5 5-5H7z"/>
            </svg>
          </button>
          <div class="kawaicord-dropdown-menu" id="kawaicord-dropdown-menu">
            ${modOptions.map(opt => `
              <div class="kawaicord-dropdown-item${opt.value === config.activeMod ? ' selected' : ''}" data-value="${opt.value}">
                <span>${opt.label}</span>
                ${opt.value === config.activeMod ? '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>' : ''}
              </div>
            `).join('')}
          </div>
        </div>
      </div>

      <div class="kawaicord-option">
        <div>
          <div class="kawaicord-option-label">Performance Mode</div>
          <div class="kawaicord-option-desc">Reduce background rendering to 10 FPS without pausing notifications.</div>
        </div>
        <label class="kawaicord-switch">
          <input type="checkbox" id="kawaicord-perf-toggle" ${config.performanceMode ? 'checked' : ''}>
          <span class="kawaicord-slider"></span>
        </label>
      </div>

      <div class="kawaicord-option">
        <div>
          <div class="kawaicord-option-label">Background Throttling</div>
          <div class="kawaicord-option-desc">Save more power by throttling timers. This can slightly delay some animations or plugin tasks.</div>
        </div>
        <label class="kawaicord-switch">
          <input type="checkbox" id="kawaicord-throttle-toggle" ${config.backgroundThrottling ? 'checked' : ''}>
          <span class="kawaicord-slider"></span>
        </label>
      </div>

      <div class="kawaicord-option">
        <div>
          <div class="kawaicord-option-label">Automatic Mod Updates</div>
          <div class="kawaicord-option-desc">Refresh Shelter and the selected client mod with cached, bundled fallbacks.</div>
        </div>
        <label class="kawaicord-switch">
          <input type="checkbox" id="kawaicord-update-toggle" ${config.autoUpdateMods ? 'checked' : ''}>
          <span class="kawaicord-slider"></span>
        </label>
      </div>

      <div class="kawaicord-option">
        <div>
          <div class="kawaicord-option-label">arRPC</div>
          <div class="kawaicord-option-desc">Enable Discord Rich Presence bridge.</div>
        </div>
        <label class="kawaicord-switch">
          <input type="checkbox" id="kawaicord-arrpc-toggle" ${config.arRPC ? 'checked' : ''}>
          <span class="kawaicord-slider"></span>
        </label>
      </div>

      <div class="kawaicord-option">
        <div>
          <div class="kawaicord-option-label">Start at Login</div>
          <div class="kawaicord-option-desc">Launch Kawaicord when Windows starts.</div>
        </div>
        <label class="kawaicord-switch">
          <input type="checkbox" id="kawaicord-start-login-toggle" ${config.startAtLogin ? 'checked' : ''}>
          <span class="kawaicord-slider"></span>
        </label>
      </div>

      <div class="kawaicord-option">
        <div>
          <div class="kawaicord-option-label">Close to Tray</div>
          <div class="kawaicord-option-desc">Keep app in tray when closed.</div>
        </div>
        <label class="kawaicord-switch">
          <input type="checkbox" id="kawaicord-close-tray-toggle" ${config.minimizeToTray ? 'checked' : ''}>
          <span class="kawaicord-slider"></span>
        </label>
      </div>

      <div class="kawaicord-option">
        <div>
          <div class="kawaicord-option-label">Enable Tray Icon</div>
          <div class="kawaicord-option-desc">Show tray icon and menu.</div>
        </div>
        <label class="kawaicord-switch">
          <input type="checkbox" id="kawaicord-tray-enable-toggle" ${config.trayEnabled ? 'checked' : ''}>
          <span class="kawaicord-slider"></span>
        </label>
      </div>

      <div class="kawaicord-option">
        <button type="button" class="kawaicord-btn" id="kawaicord-restart-btn">Restart Kawaicord</button>
      </div>
    </div>
  `;

  const get = <T extends Element>(selector: string) => container.querySelector(selector) as T | null;

  // --- Custom dropdown logic ---
  const dropdown = get<HTMLDivElement>('#kawaicord-mod-dropdown');
  const trigger = get<HTMLButtonElement>('#kawaicord-dropdown-trigger');
  const menu = get<HTMLDivElement>('#kawaicord-dropdown-menu');
  const banner = get<HTMLDivElement>('#kawaicord-restart-banner');

  if (trigger && menu && dropdown) {
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      const isOpen = dropdown.classList.toggle('open');
      if (isOpen) {
        // Close on outside click
        const closeHandler = (ev: MouseEvent) => {
          if (!dropdown.contains(ev.target as Node)) {
            dropdown.classList.remove('open');
            document.removeEventListener('click', closeHandler);
          }
        };
        // Defer so the current click doesn't immediately close it
        setTimeout(() => document.addEventListener('click', closeHandler), 0);
      }
    });

    menu.querySelectorAll('.kawaicord-dropdown-item').forEach((item) => {
      item.addEventListener('click', async () => {
        const value = (item as HTMLElement).dataset.value as ActiveMod;
        if (!value) return;
        if (value === selectedMod) {
          dropdown.classList.remove('open');
          return;
        }

        // Update visual state
        menu.querySelectorAll('.kawaicord-dropdown-item').forEach(el => {
          el.classList.remove('selected');
          // Remove existing checkmarks
          const check = el.querySelector('svg');
          if (check) check.remove();
        });
        item.classList.add('selected');
        // Add checkmark
        const checkSvg = document.createElement('span');
        checkSvg.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>';
        item.appendChild(checkSvg.firstElementChild!);

        // Update trigger text
        const label = modOptions.find(o => o.value === value)?.label ?? value;
        const valueSpan = trigger.querySelector('.kawaicord-dropdown-value');
        if (valueSpan) valueSpan.textContent = label;

        // Close dropdown
        dropdown.classList.remove('open');

        // Save config
        await (window as any).kawaicord.setConfig({ activeMod: value });
        selectedMod = value;

        // Show restart banner
        if (banner) {
          banner.style.display = 'flex';
          banner.classList.add('show');
        }
      });
    });
  }

  // --- Restart banner buttons ---
  get<HTMLButtonElement>('#kawaicord-banner-ignore')?.addEventListener('click', () => {
    if (banner) {
      banner.classList.remove('show');
      setTimeout(() => { banner.style.display = 'none'; }, 200);
    }
  });

  get<HTMLButtonElement>('#kawaicord-banner-restart')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = 'Restarting…';
    void (window as any).kawaicord.restart();
  });

  // --- Toggle handlers ---
  get<HTMLInputElement>('#kawaicord-perf-toggle')?.addEventListener('change', async (e) => {
    await (window as any).kawaicord.setConfig({ performanceMode: (e.target as HTMLInputElement).checked });
  });

  get<HTMLInputElement>('#kawaicord-throttle-toggle')?.addEventListener('change', async (e) => {
    await (window as any).kawaicord.setConfig({ backgroundThrottling: (e.target as HTMLInputElement).checked });
  });

  get<HTMLInputElement>('#kawaicord-update-toggle')?.addEventListener('change', async (e) => {
    await (window as any).kawaicord.setConfig({ autoUpdateMods: (e.target as HTMLInputElement).checked });
  });

  get<HTMLInputElement>('#kawaicord-arrpc-toggle')?.addEventListener('change', async (e) => {
    await (window as any).kawaicord.setConfig({ arRPC: (e.target as HTMLInputElement).checked });
  });

  get<HTMLInputElement>('#kawaicord-start-login-toggle')?.addEventListener('change', async (e) => {
    await (window as any).kawaicord.setConfig({ startAtLogin: (e.target as HTMLInputElement).checked });
  });

  get<HTMLInputElement>('#kawaicord-close-tray-toggle')?.addEventListener('change', async (e) => {
    await (window as any).kawaicord.setConfig({ minimizeToTray: (e.target as HTMLInputElement).checked });
  });

  get<HTMLInputElement>('#kawaicord-tray-enable-toggle')?.addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    await (window as any).kawaicord.setConfig({ trayEnabled: enabled });
    (window as any).kawaicord.toggleTray(enabled);
  });

  // --- Restart button (full app restart) ---
  get<HTMLButtonElement>('#kawaicord-restart-btn')?.addEventListener('click', (event) => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    button.textContent = 'Restarting…';
    void (window as any).kawaicord.restart();
  });
}

(window as any).kawaicordRenderSettingsPage = (container?: HTMLElement) => {
  void renderSettingsPage(container);
};

function injectSettingsCss() {
  const style = document.createElement('style');
  style.textContent = `
.kawaicord-settings-page {
  --kawaicord-accent: #c084fc;
  --kawaicord-accent-strong: #a855f7;
  padding: 28px;
  color: var(--text-normal);
  max-width: 860px;
}

.kawaicord-hero {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  padding: 20px;
  margin-bottom: 20px;
  border: 1px solid color-mix(in srgb, var(--kawaicord-accent) 24%, transparent);
  border-radius: 16px;
  background: linear-gradient(135deg, color-mix(in srgb, var(--kawaicord-accent) 14%, transparent), transparent 70%);
}

.kawaicord-header {
  margin-bottom: 4px;
  font-size: 24px;
  font-weight: 700;
  color: var(--header-primary);
}

.kawaicord-subtitle {
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.45;
}

.kawaicord-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
  padding: 7px 10px;
  border-radius: 999px;
  color: var(--text-normal);
  background: color-mix(in srgb, var(--kawaicord-accent) 16%, transparent);
  font-size: 12px;
  font-weight: 600;
}

.kawaicord-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #4ade80;
  box-shadow: 0 0 0 3px color-mix(in srgb, #4ade80 18%, transparent);
}

.kawaicord-status.recovery .kawaicord-status-dot {
  background: #fbbf24;
  box-shadow: 0 0 0 3px color-mix(in srgb, #fbbf24 18%, transparent);
}

.kawaicord-recovery-notice {
  margin-bottom: 18px;
  padding: 12px 14px;
  border: 1px solid color-mix(in srgb, #fbbf24 34%, transparent);
  border-radius: 10px;
  background: color-mix(in srgb, #fbbf24 10%, transparent);
  color: var(--text-normal);
  font-size: 13px;
  line-height: 1.45;
}

.kawaicord-section {
  margin-bottom: 40px;
}

.kawaicord-option {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  margin-bottom: 0;
  padding: 18px 4px;
  border-bottom: 1px solid var(--background-modifier-accent);
}

.kawaicord-option-label {
  font-size: 16px;
  font-weight: 500;
  color: var(--header-primary);
}

.kawaicord-option-desc {
  font-size: 13px;
  color: var(--text-muted);
  margin-top: 4px;
}

/* Custom Dropdown */
.kawaicord-dropdown {
  position: relative;
  min-width: 180px;
}

.kawaicord-dropdown-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 8px 12px;
  background: var(--input-background-default, var(--background-secondary));
  color: var(--input-text-default, var(--text-normal));
  border: 1px solid var(--input-border-default, transparent);
  border-radius: var(--radius-sm, 4px);
  font-size: 16px;
  font-weight: 500;
  font-family: var(--font-primary);
  cursor: pointer;
  transition: border-color 0.15s ease;
  line-height: 1.25;
  min-height: 40px;
  box-sizing: border-box;
}

.kawaicord-dropdown-trigger:hover {
  border-color: var(--input-border-hover, var(--border-subtle));
}

.kawaicord-dropdown-trigger:focus-visible {
  outline: 2px solid var(--kawaicord-accent);
  outline-offset: -2px;
}

.kawaicord-dropdown-chevron {
  margin-left: 8px;
  color: var(--interactive-normal);
  transition: transform 0.2s ease;
  flex-shrink: 0;
}

.kawaicord-dropdown.open .kawaicord-dropdown-chevron {
  transform: rotate(180deg);
}

.kawaicord-dropdown-menu {
  display: none;
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  min-width: 100%;
  background-color: var(--background-surface-higher, var(--background-floating));
  border: 1px solid var(--border-subtle, transparent);
  border-radius: 8px;
  box-shadow: var(--elevation-high, var(--shadow-high, 0 8px 16px rgba(0,0,0,0.24)));
  z-index: 1000;
  padding: 4px;
  animation: kawaicord-dropdown-fadein 0.15s ease;
}

@keyframes kawaicord-dropdown-fadein {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

.kawaicord-dropdown.open .kawaicord-dropdown-menu {
  display: block;
}

.kawaicord-dropdown-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  border-radius: 4px;
  color: var(--text-subtle, var(--interactive-normal));
  font-size: 16px;
  font-weight: 400;
  font-family: var(--font-primary);
  cursor: pointer;
  transition: background-color 0.1s ease, color 0.1s ease;
  user-select: none;
  line-height: 20px;
}

.kawaicord-dropdown-item:hover {
  background-color: var(--interactive-background-hover, rgba(79,84,92,0.16));
  color: var(--interactive-text-hover, var(--text-normal));
}

.kawaicord-dropdown-item.selected {
  background-color: var(--interactive-background-selected, var(--background-modifier-selected));
  color: var(--interactive-text-active, var(--text-normal));
}

.kawaicord-dropdown-item.selected svg {
  color: var(--interactive-text-active, var(--brand-experiment, #5865F2));
}

/* Restart Warning Banner */
.kawaicord-restart-banner {
  display: none;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  margin-bottom: 16px;
  background: var(--info-warning-background, #faa81a1a);
  border: 1px solid var(--info-warning-foreground, #faa81a33);
  border-radius: 8px;
  color: var(--text-normal);
  opacity: 0;
  transform: translateY(-8px);
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.kawaicord-restart-banner.show {
  opacity: 1;
  transform: translateY(0);
}

.kawaicord-restart-banner-content {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.kawaicord-restart-banner-icon {
  color: var(--info-warning-foreground, #faa81a);
  flex-shrink: 0;
}

.kawaicord-restart-banner-text {
  font-size: 14px;
  line-height: 1.3;
  color: var(--text-normal);
}

.kawaicord-restart-banner-actions {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
}

.kawaicord-banner-btn {
  padding: 6px 16px;
  border-radius: 3px;
  font-size: 13px;
  font-weight: 500;
  font-family: var(--font-primary);
  cursor: pointer;
  border: none;
  transition: background-color 0.15s ease, opacity 0.15s ease;
  line-height: 16px;
}

.kawaicord-banner-btn-ignore {
  background: transparent;
  color: var(--text-normal);
}

.kawaicord-banner-btn-ignore:hover {
  text-decoration: underline;
}

.kawaicord-banner-btn-restart {
  background: var(--kawaicord-accent-strong);
  color: #fff;
}

.kawaicord-banner-btn-restart:hover {
  background: var(--brand-experiment-560, #4752c4);
}

/* Toggle Switch */
.kawaicord-switch {
  position: relative;
  display: inline-block;
  width: 40px;
  height: 24px;
  flex-shrink: 0;
}

.kawaicord-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.kawaicord-slider {
  position: absolute;
  cursor: pointer;
  inset: 0;
  background-color: var(--input-background, #80848e);
  transition: .2s;
  border-radius: 14px;
}

.kawaicord-slider:before {
  position: absolute;
  content: "";
  height: 18px;
  width: 18px;
  left: 3px;
  bottom: 3px;
  background-color: white;
  transition: .2s;
  border-radius: 50%;
}

.kawaicord-switch input:checked + .kawaicord-slider {
  background-color: var(--kawaicord-accent-strong);
}

.kawaicord-switch input:checked + .kawaicord-slider:before {
  transform: translateX(16px);
}

/* Button */
.kawaicord-btn {
  background-color: var(--kawaicord-accent-strong);
  color: white;
  border: none;
  border-radius: 3px;
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 500;
  font-family: var(--font-primary);
  cursor: pointer;
  transition: background-color 0.15s ease;
  line-height: 16px;
}

.kawaicord-btn:hover {
  background-color: #9333ea;
}
`;

  document.head.appendChild(style);
}

function setImportantStyle(element: HTMLElement, property: string, value: string) {
  if (
    element.style.getPropertyValue(property) !== value ||
    element.style.getPropertyPriority(property) !== 'important'
  ) {
    element.style.setProperty(property, value, 'important');
  }
}

function lockWindowControlHost(host: HTMLElement) {
  const lockedStyles: Record<string, string> = {
    position: 'fixed',
    top: '0px',
    right: '0px',
    bottom: 'auto',
    left: 'auto',
    'z-index': '2147483646',
    display: 'block',
    width: `${TITLEBAR_CONTROLS_WIDTH}px`,
    height: `${TITLEBAR_FALLBACK_HEIGHT}px`,
    'min-width': `${TITLEBAR_CONTROLS_WIDTH}px`,
    'max-width': `${TITLEBAR_CONTROLS_WIDTH}px`,
    'min-height': `${TITLEBAR_FALLBACK_HEIGHT}px`,
    'max-height': `${TITLEBAR_FALLBACK_HEIGHT}px`,
    margin: '0px',
    padding: '0px',
    border: '0px',
    transform: 'none',
    translate: 'none',
    scale: 'none',
    rotate: 'none',
    overflow: 'hidden',
    isolation: 'isolate',
    contain: 'layout style',
    'box-sizing': 'border-box',
    'pointer-events': 'auto',
    visibility: 'visible',
    opacity: '1',
    color: 'var(--interactive-icon-default, var(--interactive-normal, #b5bac1))',
    'background-color': 'var(--background-base-lowest, var(--background-tertiary, #111214))',
    'font-family': 'var(--font-primary, "gg sans", "Segoe UI", sans-serif)',
    '-webkit-app-region': 'no-drag'
  };

  for (const [property, value] of Object.entries(lockedStyles)) {
    setImportantStyle(host, property, value);
  }
}

function lockNativeAppBar() {
  const root = document.documentElement;
  const body = document.body;
  if (!root || !body) return;

  setImportantStyle(root, '--custom-app-top-bar-height', `${TITLEBAR_FALLBACK_HEIGHT}px`);
  setImportantStyle(root, '--kawaicord-titlebar-height', `${TITLEBAR_FALLBACK_HEIGHT}px`);
  setImportantStyle(root, '--kawaicord-window-controls-width', `${TITLEBAR_CONTROLS_WIDTH}px`);
  setImportantStyle(root, '--kawaicord-window-controls-reserved-width', `${TITLEBAR_RESERVED_WIDTH}px`);

  if (!body.hasAttribute('customTitlebar')) body.setAttribute('customTitlebar', '');
  if (body.getAttribute('kawaicord-platform') !== process.platform) {
    body.setAttribute('kawaicord-platform', process.platform);
  }
  if (process.platform === 'win32' && !body.classList.contains('platform-win')) {
    body.classList.add('platform-win');
  }

  const host = document.getElementById('kawaicord-window-controls');
  if (host) lockWindowControlHost(host);

  const trailingCandidates = document.querySelectorAll<HTMLElement>(
    'div[class*="title"] + div[class*="trailing"]'
  );
  const trailing = Array.from(trailingCandidates).find(candidate => {
    const bar = candidate.parentElement;
    if (!bar) return false;
    const rect = bar.getBoundingClientRect();
    return rect.top < TITLEBAR_FALLBACK_HEIGHT * 2;
  });
  const title = trailing?.previousElementSibling as HTMLElement | null;
  const bar = trailing?.parentElement;
  if (!trailing || !title || !bar) return;

  const barStyles: Record<string, string> = {
    height: `${TITLEBAR_FALLBACK_HEIGHT}px`,
    'min-height': `${TITLEBAR_FALLBACK_HEIGHT}px`,
    'max-height': `${TITLEBAR_FALLBACK_HEIGHT}px`,
    margin: '0px',
    transform: 'none',
    translate: 'none',
    scale: 'none',
    rotate: 'none',
    overflow: 'visible',
    'box-sizing': 'border-box'
  };
  for (const [property, value] of Object.entries(barStyles)) {
    setImportantStyle(bar, property, value);
  }

  for (const element of [title, trailing]) {
    setImportantStyle(element, 'transform', 'none');
    setImportantStyle(element, 'translate', 'none');
    setImportantStyle(element, 'scale', 'none');
    setImportantStyle(element, 'rotate', 'none');
  }
  setImportantStyle(trailing, 'margin-inline-end', `${TITLEBAR_RESERVED_WIDTH}px`);
  setImportantStyle(trailing, 'margin-right', `${TITLEBAR_RESERVED_WIDTH}px`);

  for (const interactive of Array.from(
    bar.querySelectorAll<HTMLElement>('button, a, [role="button"]')
  )) {
    setImportantStyle(interactive, 'transform', 'none');
    setImportantStyle(interactive, 'translate', 'none');
    setImportantStyle(interactive, 'visibility', 'visible');
  }
}

function injectTitlebar() {
  if (document.getElementById('kawaicord-window-controls')) return;

  const globalStyle = document.createElement('style');
  globalStyle.id = 'kawaicord-titlebar-style';
  globalStyle.textContent = KAWAICORD_TITLEBAR_CSS;
  document.head.appendChild(globalStyle);

  const host = document.createElement('div');
  host.id = 'kawaicord-window-controls';
  host.setAttribute('role', 'group');
  host.setAttribute('aria-label', 'Window controls');
  lockWindowControlHost(host);

  const shadow = host.attachShadow({ mode: 'closed' });
  const shadowStyle = document.createElement('style');
  shadowStyle.textContent = KAWAICORD_WINDOW_CONTROLS_CSS;
  const controls = document.createElement('div');
  controls.className = 'controls';
  controls.innerHTML = `
    <button type="button" aria-label="Minimize" title="Minimize"><span class="icon minimize"></span></button>
    <button type="button" aria-label="Maximize" title="Maximize"><span class="icon maximize"></span></button>
    <button type="button" aria-label="Close" title="Close" class="close"><span class="icon close-icon"></span></button>
  `;
  shadow.append(shadowStyle, controls);
  document.body.appendChild(host);

  const [minimizeButton, maximizeButton, closeButton] = Array.from(
    controls.querySelectorAll<HTMLButtonElement>('button')
  );
  let maximizeSyncTimer: number | null = null;
  const syncMaximizedState = async () => {
    maximizeSyncTimer = null;
    const maximized = await ipcRenderer.invoke('window:isMaximized') as boolean;
    host.dataset.maximized = String(Boolean(maximized));
    document.body.dataset.kawaicordMaximized = String(Boolean(maximized));
    const label = maximized ? 'Restore' : 'Maximize';
    maximizeButton.setAttribute('aria-label', label);
    maximizeButton.setAttribute('title', label);
  };
  const scheduleMaximizedSync = () => {
    if (maximizeSyncTimer !== null) window.clearTimeout(maximizeSyncTimer);
    maximizeSyncTimer = window.setTimeout(() => void syncMaximizedState(), 80);
  };

  minimizeButton.addEventListener('click', () => ipcRenderer.send('window:minimize'));
  maximizeButton.addEventListener('click', () => {
    ipcRenderer.send('window:maximize');
    scheduleMaximizedSync();
  });
  closeButton.addEventListener('click', () => ipcRenderer.send('window:close'));
  window.addEventListener('resize', scheduleMaximizedSync, { passive: true });

  let guardFrame: number | null = null;
  const enforceLocks = () => {
    guardFrame = null;
    if (!globalStyle.isConnected) document.head.appendChild(globalStyle);
    lockNativeAppBar();
  };
  const scheduleGuard = () => {
    if (guardFrame === null) guardFrame = window.requestAnimationFrame(enforceLocks);
  };

  const layoutObserver = new MutationObserver(scheduleGuard);
  layoutObserver.observe(document.head, { childList: true });
  layoutObserver.observe(document.body, { childList: true, subtree: true });

  const protectedAttributeObserver = new MutationObserver(scheduleGuard);
  protectedAttributeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class', 'style', 'data-theme']
  });
  protectedAttributeObserver.observe(document.body, {
    attributes: true,
    attributeFilter: ['class', 'style', 'customTitlebar', 'kawaicord-platform']
  });
  protectedAttributeObserver.observe(host, {
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden']
  });

  lockNativeAppBar();
  void syncMaximizedState();
}

function initThemeObserver() {
  const root = document.documentElement;
  const body = document.body;
  if (!root || !body) return;

  let updateTimer: number | null = null;
  let lastBackgroundColor = '';
  let lastTrayTheme = '';
  let trayIconAuto = true;
  void (window as any).kawaicord.getConfig().then((config: Partial<KawaicordConfig>) => {
    trayIconAuto = config?.trayIconAuto !== false;
  });

  const updateTheme = () => {
    updateTimer = null;
    const controls = document.getElementById('kawaicord-window-controls');
    if (controls) {
      const color = cssRgbToHex(getComputedStyle(controls).backgroundColor);
      if (color && color !== lastBackgroundColor) {
        lastBackgroundColor = color;
        ipcRenderer.send('window:setBackgroundColor', color);
      }
    }

    if (trayIconAuto) {
      const classes = `${root.className} ${body.className}`;
      const isLight = classes.includes('theme-light');
      const trayTheme = isLight ? 'light' : 'dark';
      if (trayTheme !== lastTrayTheme) {
        lastTrayTheme = trayTheme;
        (window as any).kawaicord.setTrayIcon(trayTheme);
      }
    }
  };
  const scheduleUpdate = () => {
    if (updateTimer !== null) window.clearTimeout(updateTimer);
    updateTimer = window.setTimeout(updateTheme, 50);
  };
  const themeObserver = new MutationObserver(scheduleUpdate);

  for (const target of [root, body]) {
    themeObserver.observe(target, {
      attributes: true,
      attributeFilter: ['class', 'style', 'data-theme']
    });
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', scheduleUpdate);
  scheduleUpdate();
}

window.addEventListener('DOMContentLoaded', () => {
  injectSettingsCss();
  injectTitlebar();
  initThemeObserver();
});

injectCompatibilityPatches();
injectMod();
