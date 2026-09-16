import { ipcRenderer, webFrame } from 'electron';
import { shouldReleaseImageCache } from './performance';
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
  autoUpdateApp: boolean;
};

type AppUpdateStatus = {
  phase: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'up-to-date' | 'error';
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  message: string;
  checkedAt?: number;
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
  autoUpdateMods: true,
  autoUpdateApp: true
};

(window as any).kawaicord = {
  version: async () => await ipcRenderer.invoke('kawaicord:getVersion'),
  reload: async () => await ipcRenderer.invoke('kawaicord:reload'),
  restart: async () => await ipcRenderer.invoke('kawaicord:restart'),
  getConfig: async () => await ipcRenderer.invoke('kawaicord:getConfig'),
  getRuntimeStatus: async () => await ipcRenderer.invoke('kawaicord:getRuntimeStatus'),
  setConfig: async (config: Partial<KawaicordConfig>) => await ipcRenderer.invoke('kawaicord:setConfig', config),
  getUpdateStatus: async () => await ipcRenderer.invoke('kawaicord:getUpdateStatus'),
  checkForUpdates: async () => await ipcRenderer.invoke('kawaicord:checkForUpdates'),
  installUpdate: async () => await ipcRenderer.invoke('kawaicord:installUpdate'),
  onUpdateStatus: (callback: (status: AppUpdateStatus) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, status: AppUpdateStatus) => callback(status);
    ipcRenderer.on('kawaicord:updateStatus', listener);
    return () => ipcRenderer.removeListener('kawaicord:updateStatus', listener);
  },
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

type InjectionStatus = {
  shelter: boolean;
  mod: ActiveMod | null;
  restartHooks: number;
  attempts: number;
  reason: string;
  error: string | null;
};

const injectionStatus: InjectionStatus = {
  shelter: false,
  mod: null,
  restartHooks: 0,
  attempts: 0,
  reason: 'preload',
  error: null
};
(window as any).kawaicordInjectionStatus = injectionStatus;

let injectionPromise: Promise<boolean> | null = null;
let injectionComplete = false;
let injectionRetryTimer: number | null = null;
// Acquire local bundles before yielding to Discord's scripts. Async IPC here
// races webpack startup and Discord's removal of window.localStorage.
let startupBundles = ipcRenderer.sendSync('kawaicord:getStartupBundles');

async function injectModOnce(reason: string): Promise<boolean> {
  injectionStatus.attempts += 1;
  injectionStatus.reason = reason;
  injectionStatus.error = null;
  const errors: string[] = [];

  if (!injectionStatus.shelter) {
    try {
      if (startupBundles?.error) throw new Error(startupBundles.error);
      const shelterBundle = startupBundles.shelter as { js?: string };
      if (shelterBundle?.js) {
        await webFrame.executeJavaScript(`(()=>{
  if (window.__kawaicordShelterInjected === true) return;

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

  window.__kawaicordShelterInjected = true;
})()`);
        console.log('Shelter JS injected');
        injectionStatus.shelter = true;
      } else {
        throw new Error('Shelter bundle was empty');
      }
    } catch (e) {
      console.error('Failed to inject Shelter:', e);
      errors.push(`Shelter failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  try {
    const runtime = startupBundles as {
      activeMod: ActiveMod;
      safeMode: boolean;
    };

    if (runtime.safeMode) {
      console.warn('Recovery mode is active; Shelter loaded without Vencord or Equicord.');
      return injectionStatus.shelter;
    }

    if (injectionStatus.mod === runtime.activeMod) return injectionStatus.shelter;

    const bundle = startupBundles.mod as {
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

    const alreadyInjected = await webFrame.executeJavaScript(
      `window.__kawaicordClientMod === ${JSON.stringify(runtime.activeMod)}`
    ) as boolean;
    if (!alreadyInjected) {
      // Keep the browser bundle at true page scope. Vencord and Equicord create
      // globals during startup; wrapping the bundle in a function can strand
      // those globals and intermittently prevent Discord from mounting.
      await webFrame.executeJavaScript(
        `${patchedBundle.source}\n//# sourceURL=kawaicord-${runtime.activeMod}.js`
      );
      await webFrame.executeJavaScript(
        `window.__kawaicordClientMod = ${JSON.stringify(runtime.activeMod)}`
      );
    }
    if (bundle.css) await webFrame.insertCSS(bundle.css);
    injectionStatus.mod = runtime.activeMod;
    if (injectionStatus.shelter) startupBundles = null; // Release source after startup.
    console.log(`${runtime.activeMod} injected`);
  } catch (error) {
    console.error('Failed to inject mod:', error);
    errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    injectionStatus.error = errors.length > 0 ? errors.join('; ') : null;
    ipcRenderer.send('kawaicord:injectionStatus', injectionStatus);
  }

  return injectionStatus.shelter && injectionStatus.mod !== null && errors.length === 0;
}

function ensureClientModsInjected(reason: string): Promise<boolean> {
  if (injectionComplete) return Promise.resolve(true);
  if (injectionPromise) return injectionPromise;

  if (injectionRetryTimer !== null) {
    window.clearTimeout(injectionRetryTimer);
    injectionRetryTimer = null;
  }

  injectionPromise = injectModOnce(reason)
    .then(success => {
      injectionComplete = success;
      return success;
    })
    .catch(error => {
      injectionStatus.error = error instanceof Error ? error.message : String(error);
      ipcRenderer.send('kawaicord:injectionStatus', injectionStatus);
      return false;
    })
    .finally(() => {
      injectionPromise = null;
      if (!injectionComplete && injectionStatus.attempts < 3) {
        const delay = 500 * injectionStatus.attempts;
        injectionRetryTimer = window.setTimeout(() => {
          injectionRetryTimer = null;
          void ensureClientModsInjected('automatic retry');
        }, delay);
      }
    });

  return injectionPromise;
}

ipcRenderer.on('kawaicord:ensureInjection', (_event, reason?: string) => {
  void ensureClientModsInjected(reason || 'main-process check');
});

async function renderSettingsPage(targetContainer?: HTMLElement) {
  const container = targetContainer;
  if (!container) {
    return;
  }

  const [rawConfig, runtime, appVersion, initialUpdateStatus] = await Promise.all([
    (window as any).kawaicord.getConfig() as Promise<Partial<KawaicordConfig>>,
    (window as any).kawaicord.getRuntimeStatus() as Promise<{
      activeMod: ActiveMod;
      safeMode: boolean;
      logPath: string;
    }>,
    (window as any).kawaicord.version() as Promise<string>,
    (window as any).kawaicord.getUpdateStatus() as Promise<AppUpdateStatus>
  ]);
  const config: KawaicordConfig = { ...defaultConfig, ...rawConfig };

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
      <div class="kawaicord-section-heading">Client</div>
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
          <div class="kawaicord-option-desc">Pause decorative animation while hidden without delaying notifications, calls, or messages.</div>
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
    </div>

    <div class="kawaicord-section">
      <div class="kawaicord-section-heading">Updates</div>
      <div class="kawaicord-option">
        <div>
          <div class="kawaicord-option-label">Automatic App Updates</div>
          <div class="kawaicord-option-desc">Check GitHub Releases in the background and download verified updates. Installation happens on restart or exit.</div>
        </div>
        <label class="kawaicord-switch">
          <input type="checkbox" id="kawaicord-app-update-toggle" ${config.autoUpdateApp ? 'checked' : ''}>
          <span class="kawaicord-slider"></span>
        </label>
      </div>

      <div class="kawaicord-update-card" id="kawaicord-update-card" data-phase="idle">
        <div class="kawaicord-update-copy">
          <div class="kawaicord-update-version">Kawaicord ${appVersion}</div>
          <div class="kawaicord-update-message" id="kawaicord-update-message" role="status" aria-live="polite"></div>
          <div class="kawaicord-update-progress" id="kawaicord-update-progress" hidden>
            <div class="kawaicord-update-progress-fill" id="kawaicord-update-progress-fill"></div>
          </div>
        </div>
        <div class="kawaicord-update-actions">
          <button type="button" class="kawaicord-btn kawaicord-btn-secondary" id="kawaicord-check-update-btn">Check for updates</button>
          <button type="button" class="kawaicord-btn" id="kawaicord-install-update-btn" hidden>Restart and update</button>
        </div>
      </div>
    </div>

    <div class="kawaicord-section kawaicord-section-actions">
      <div class="kawaicord-option">
        <button type="button" class="kawaicord-btn" id="kawaicord-restart-btn">Restart Kawaicord</button>
      </div>
    </div>
  `;

  const get = <T extends Element>(selector: string) => container.querySelector(selector) as T | null;

  const updateCard = get<HTMLDivElement>('#kawaicord-update-card');
  const updateMessage = get<HTMLDivElement>('#kawaicord-update-message');
  const updateProgress = get<HTMLDivElement>('#kawaicord-update-progress');
  const updateProgressFill = get<HTMLDivElement>('#kawaicord-update-progress-fill');
  const checkUpdateButton = get<HTMLButtonElement>('#kawaicord-check-update-btn');
  const installUpdateButton = get<HTMLButtonElement>('#kawaicord-install-update-btn');

  const applyUpdateStatus = (status: AppUpdateStatus) => {
    if (!status || !updateCard || !updateMessage || !checkUpdateButton || !installUpdateButton) return;
    updateCard.dataset.phase = status.phase;
    updateMessage.textContent = status.message;

    const busy = status.phase === 'checking' || status.phase === 'available' || status.phase === 'downloading';
    checkUpdateButton.disabled = busy || status.phase === 'downloaded' || status.phase === 'disabled';
    checkUpdateButton.textContent = status.phase === 'checking'
      ? 'Checking…'
      : status.phase === 'available' || status.phase === 'downloading'
        ? 'Downloading…'
        : 'Check for updates';
    installUpdateButton.hidden = status.phase !== 'downloaded';

    const showProgress = status.phase === 'downloading' || status.phase === 'downloaded';
    if (updateProgress && updateProgressFill) {
      updateProgress.hidden = !showProgress;
      const percent = status.phase === 'downloaded' ? 100 : Math.max(0, Math.min(100, status.percent ?? 0));
      updateProgressFill.style.width = `${percent}%`;
      updateProgress.setAttribute('aria-label', `${Math.round(percent)}% downloaded`);
    }
  };

  const previousUpdateCleanup = (container as HTMLElement & { __kawaicordUpdateCleanup?: () => void })
    .__kawaicordUpdateCleanup;
  previousUpdateCleanup?.();
  const unsubscribeUpdateStatus = (window as any).kawaicord.onUpdateStatus((status: AppUpdateStatus) => {
    if (!container.isConnected) {
      unsubscribeUpdateStatus();
      return;
    }
    applyUpdateStatus(status);
  });
  (container as HTMLElement & { __kawaicordUpdateCleanup?: () => void }).__kawaicordUpdateCleanup =
    unsubscribeUpdateStatus;
  applyUpdateStatus(initialUpdateStatus);

  checkUpdateButton?.addEventListener('click', async () => {
    checkUpdateButton.disabled = true;
    const status = await (window as any).kawaicord.checkForUpdates() as AppUpdateStatus;
    applyUpdateStatus(status);
  });

  installUpdateButton?.addEventListener('click', async () => {
    installUpdateButton.disabled = true;
    installUpdateButton.textContent = 'Installing…';
    const started = await (window as any).kawaicord.installUpdate() as boolean;
    if (!started) {
      installUpdateButton.disabled = false;
      installUpdateButton.textContent = 'Restart and update';
    }
  });

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

  get<HTMLInputElement>('#kawaicord-app-update-toggle')?.addEventListener('change', async (e) => {
    await (window as any).kawaicord.setConfig({ autoUpdateApp: (e.target as HTMLInputElement).checked });
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

.kawaicord-section-heading {
  margin-bottom: 6px;
  color: var(--header-primary);
  font-size: 18px;
  font-weight: 700;
}

.kawaicord-section-actions {
  margin-bottom: 0;
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

.kawaicord-update-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--background-modifier-accent);
  border-radius: 12px;
  background: var(--background-secondary, var(--background-base-low));
}

.kawaicord-update-card[data-phase="downloaded"] {
  border-color: color-mix(in srgb, #4ade80 42%, transparent);
}

.kawaicord-update-card[data-phase="error"] {
  border-color: color-mix(in srgb, #f23f43 42%, transparent);
}

.kawaicord-update-copy {
  flex: 1;
  min-width: 0;
}

.kawaicord-update-version {
  color: var(--header-primary);
  font-size: 14px;
  font-weight: 600;
}

.kawaicord-update-message {
  margin-top: 4px;
  color: var(--text-muted);
  font-size: 13px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}

.kawaicord-update-progress {
  width: min(360px, 100%);
  height: 4px;
  margin-top: 12px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--background-modifier-accent);
}

.kawaicord-update-progress-fill {
  width: 0;
  height: 100%;
  border-radius: inherit;
  background: var(--kawaicord-accent-strong);
  transition: width 120ms linear;
}

.kawaicord-update-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex: 0 0 auto;
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

.kawaicord-btn-secondary {
  background-color: var(--button-secondary-background, var(--background-modifier-accent));
  color: var(--button-secondary-text, var(--text-normal));
}

.kawaicord-btn-secondary:hover {
  background-color: var(--button-secondary-background-hover, var(--background-modifier-hover));
}

.kawaicord-btn:disabled {
  cursor: default;
  opacity: 0.55;
}

@media (max-width: 720px) {
  .kawaicord-update-card {
    align-items: stretch;
    flex-direction: column;
  }

  .kawaicord-update-actions {
    justify-content: flex-end;
  }
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

function injectBootSplash() {
  const mount = () => {
    if (!document.body || document.getElementById('kawaicord-boot-splash')) return false;

    const host = document.createElement('div');
    host.id = 'kawaicord-boot-splash';
    host.setAttribute('aria-label', 'Loading Discord');
    host.setAttribute('role', 'status');
    const lockedStyles: Record<string, string> = {
      position: 'fixed',
      inset: '0px',
      'z-index': '2147483645',
      display: 'grid',
      margin: '0px',
      padding: '0px',
      border: '0px',
      transform: 'none',
      opacity: '1',
      visibility: 'visible',
      'pointer-events': 'none',
      'background-color': '#111214',
      isolation: 'isolate',
      contain: 'strict'
    };
    for (const [property, value] of Object.entries(lockedStyles)) {
      setImportantStyle(host, property, value);
    }

    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = `
      :host {
        color: #dbdee1;
        font-family: "gg sans", "Segoe UI", sans-serif;
      }
      .splash {
        display: grid;
        min-width: 180px;
        place-items: center;
        gap: 14px;
        transform: translateY(-12px);
      }
      svg {
        width: 52px;
        height: 52px;
        filter: drop-shadow(0 8px 22px rgba(168, 85, 247, 0.24));
      }
      .label {
        color: #b5bac1;
        font-size: 13px;
        font-weight: 500;
        letter-spacing: 0.01em;
      }
      .detail {
        max-width: 360px;
        color: #949ba4;
        font-size: 12px;
        line-height: 1.45;
        text-align: center;
      }
      .retry {
        padding: 8px 14px;
        border: 0;
        border-radius: 6px;
        color: #fff;
        background: #7c3aed;
        font-family: inherit;
        font-size: 13px;
        font-weight: 600;
        line-height: 18px;
        cursor: pointer;
      }
      .retry:hover { background: #6d28d9; }
      [hidden] { display: none !important; }
      .dots {
        display: flex;
        gap: 5px;
      }
      .dots span {
        width: 5px;
        height: 5px;
        border-radius: 50%;
        background: #c084fc;
        animation: pulse 900ms ease-in-out infinite alternate;
      }
      .dots span:nth-child(2) { animation-delay: 150ms; }
      .dots span:nth-child(3) { animation-delay: 300ms; }
      @keyframes pulse {
        from { opacity: 0.3; transform: translateY(1px); }
        to { opacity: 1; transform: translateY(-2px); }
      }
      @media (prefers-reduced-motion: reduce) {
        .dots span { animation: none; opacity: 0.8; }
      }
    `;
    const content = document.createElement('div');
    content.className = 'splash';
    content.innerHTML = `
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <defs>
          <linearGradient id="kawaicord-splash-gradient" x1="12" y1="8" x2="52" y2="56" gradientUnits="userSpaceOnUse">
            <stop stop-color="#8b5cf6"/>
            <stop offset="1" stop-color="#ec4899"/>
          </linearGradient>
        </defs>
        <path fill="url(#kawaicord-splash-gradient)" d="M13 18.5 21.5 10l4.2 7.1a25 25 0 0 1 12.6 0l4.2-7.1 8.5 8.5A23 23 0 0 1 55 31.4C55 44.4 44.7 54 32 54S9 44.4 9 31.4a23 23 0 0 1 4-12.9Z"/>
        <path fill="#fff" d="M23.5 29.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6Zm17 0a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z"/>
        <path fill="#ffd8e8" d="M28 39.1c0-2.2 2-3.6 4-2.1 2-1.5 4-.1 4 2.1 0 2.8-4 5.1-4 5.1s-4-2.3-4-5.1Z"/>
      </svg>
      <div class="label">Loading Discord</div>
      <div class="detail" hidden>Kawaicord tried normal and recovery-mode reloads. You can safely try again.</div>
      <div class="dots" aria-hidden="true"><span></span><span></span><span></span></div>
      <button type="button" class="retry" hidden>Retry Discord</button>
    `;
    shadow.append(style, content);
    document.body.appendChild(host);

    const label = content.querySelector<HTMLElement>('.label')!;
    const detail = content.querySelector<HTMLElement>('.detail')!;
    const dots = content.querySelector<HTMLElement>('.dots')!;
    const retryButton = content.querySelector<HTMLButtonElement>('.retry')!;
    let checkFrame: number | null = null;
    let readyFrames = 0;
    let slowTimer: number | null = null;
    let failureTimer: number | null = null;
    let finished = false;
    const showFailure = () => {
      if (finished) return;
      label.textContent = 'Discord could not start';
      detail.hidden = false;
      dots.hidden = true;
      retryButton.hidden = false;
      setImportantStyle(host, 'pointer-events', 'auto');
    };
    const finish = () => {
      if (finished) return;
      finished = true;
      observer.disconnect();
      if (checkFrame !== null) window.cancelAnimationFrame(checkFrame);
      if (slowTimer !== null) window.clearTimeout(slowTimer);
      if (failureTimer !== null) window.clearTimeout(failureTimer);
      host.remove();
    };
    const checkReady = () => {
      checkFrame = null;
      const appMount = document.getElementById('app-mount') ||
        document.querySelector<HTMLElement>('[class*="appMount"]');
      const contentRoot = appMount || document.querySelector<HTMLElement>(
        'main, nav, [role="tree"], [class*="sidebar"]'
      );
      const contentText = appMount?.textContent?.trim() || document.body.innerText.trim();
      const visibleContent = Boolean(
        contentRoot &&
        (contentText.length > 10 || contentRoot.querySelector('button, input, [role="button"]'))
      );
      readyFrames = visibleContent ? readyFrames + 1 : 0;
      if (readyFrames >= 2) {
        ipcRenderer.send('kawaicord:discordReady');
        finish();
      }
    };
    const scheduleReadyCheck = () => {
      if (checkFrame === null) checkFrame = window.requestAnimationFrame(checkReady);
    };
    const observer = new MutationObserver(scheduleReadyCheck);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    window.addEventListener('load', scheduleReadyCheck, { once: true });
    ipcRenderer.once('kawaicord:discordFailed', showFailure);
    retryButton.addEventListener('click', () => void (window as any).kawaicord.reload());
    slowTimer = window.setTimeout(() => {
      if (!finished) label.textContent = 'Discord is taking longer than usual…';
    }, 12_000);
    failureTimer = window.setTimeout(showFailure, 70_000);
    scheduleReadyCheck();
    return true;
  };

  if (mount()) return;
  const documentObserver = new MutationObserver(() => {
    if (mount()) documentObserver.disconnect();
  });
  documentObserver.observe(document, { childList: true, subtree: true });
}

let rendererBackgrounded = false;
const backgroundListeners = new Set<(hidden: boolean) => void>();
let cacheReleaseTimer: number | undefined;
function applyBackgroundState(hidden: boolean) {
  document.documentElement.dataset.kawaicordBackgrounded = String(hidden);
  if (rendererBackgrounded === hidden) return;
  rendererBackgrounded = hidden;
  window.clearTimeout(cacheReleaseTimer);
  cacheReleaseTimer = undefined;
  for (const listener of backgroundListeners) listener(hidden);
  if (hidden) {
    // One check per hidden period; no polling, forced GC, or storage eviction.
    cacheReleaseTimer = window.setTimeout(() => {
      cacheReleaseTimer = undefined;
      if (!rendererBackgrounded) return;
      const mediaPlaying = Array.from(document.querySelectorAll<HTMLMediaElement>('video, audio'))
        .some(media => !media.paused && !media.ended);
      const { size, liveSize } = webFrame.getResourceUsage().images;
      if (shouldReleaseImageCache(size, liveSize, mediaPlaying)) webFrame.clearCache();
    }, 60_000);
  }
}

function injectPerformanceCss() {
  if (document.getElementById('kawaicord-performance-style')) return;
  const style = document.createElement('style');
  style.id = 'kawaicord-performance-style';
  style.textContent = `
    html[data-kawaicord-backgrounded="true"] *,
    html[data-kawaicord-backgrounded="true"] *::before,
    html[data-kawaicord-backgrounded="true"] *::after {
      animation-play-state: paused !important;
      transition-duration: 0s !important;
      scroll-behavior: auto !important;
    }
    /* Suppress image paint/animated avatars only while the window is hidden.
       Keep layout, audio/video elements, and all application timers intact. */
    html[data-kawaicord-backgrounded="true"] #app-mount img {
      visibility: hidden !important;
    }
  `;
  document.head.appendChild(style);
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

function lockNavigationHost(host: HTMLElement) {
  const lockedStyles: Record<string, string> = {
    position: 'fixed',
    top: '0px',
    right: 'auto',
    bottom: 'auto',
    left: '0px',
    'z-index': '2147483646',
    display: 'block',
    width: '80px',
    height: `${TITLEBAR_FALLBACK_HEIGHT}px`,
    'min-width': '80px',
    'max-width': '80px',
    'min-height': `${TITLEBAR_FALLBACK_HEIGHT}px`,
    'max-height': `${TITLEBAR_FALLBACK_HEIGHT}px`,
    margin: '0px',
    padding: '0px',
    border: '0px',
    transform: 'none',
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

function lockDragRegionHost(host: HTMLElement, rightInset = 250) {
  const lockedStyles: Record<string, string> = {
    position: 'fixed',
    top: '0px',
    right: `${Math.max(TITLEBAR_RESERVED_WIDTH, Math.round(rightInset))}px`,
    bottom: 'auto',
    left: '80px',
    'z-index': '2147483644',
    display: 'block',
    height: `${TITLEBAR_FALLBACK_HEIGHT}px`,
    'min-height': `${TITLEBAR_FALLBACK_HEIGHT}px`,
    'max-height': `${TITLEBAR_FALLBACK_HEIGHT}px`,
    margin: '0px',
    padding: '0px',
    border: '0px',
    transform: 'none',
    'background-color': 'transparent',
    'pointer-events': 'auto',
    visibility: 'visible',
    opacity: '1',
    'box-sizing': 'border-box',
    'app-region': 'drag',
    '-webkit-app-region': 'drag',
    'user-select': 'none'
  };

  for (const [property, value] of Object.entries(lockedStyles)) {
    setImportantStyle(host, property, value);
  }
}

type NativeAppBarElements = {
  bar: HTMLElement;
  title: HTMLElement;
  trailing: HTMLElement;
};

function lockNativeAppBar(): NativeAppBarElements | null {
  const root = document.documentElement;
  const body = document.body;
  if (!root || !body) return null;

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
  const navigationHost = document.getElementById('kawaicord-navigation-controls');
  if (navigationHost) lockNavigationHost(navigationHost);
  const dragRegionHost = document.getElementById('kawaicord-titlebar-drag-region');
  if (dragRegionHost) lockDragRegionHost(dragRegionHost);

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
  if (!trailing || !title || !bar) return null;

  if (dragRegionHost) {
    const rightInset = window.innerWidth - trailing.getBoundingClientRect().left + 8;
    lockDragRegionHost(dragRegionHost, rightInset);
  }

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
    'box-sizing': 'border-box',
    '-webkit-app-region': 'drag'
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
  setImportantStyle(trailing, '-webkit-app-region', 'no-drag');

  for (const interactive of Array.from(
    bar.querySelectorAll<HTMLElement>('button, a, [role="button"]')
  )) {
    setImportantStyle(interactive, 'transform', 'none');
    setImportantStyle(interactive, 'translate', 'none');
    setImportantStyle(interactive, 'visibility', 'visible');
    setImportantStyle(interactive, '-webkit-app-region', 'no-drag');
  }

  return { bar, title, trailing };
}

function injectTitlebar() {
  if (document.getElementById('kawaicord-window-controls')) return;

  const globalStyle = document.createElement('style');
  globalStyle.id = 'kawaicord-titlebar-style';
  globalStyle.textContent = KAWAICORD_TITLEBAR_CSS;
  document.head.appendChild(globalStyle);

  const dragRegionHost = document.createElement('div');
  dragRegionHost.id = 'kawaicord-titlebar-drag-region';
  dragRegionHost.setAttribute('aria-hidden', 'true');
  lockDragRegionHost(dragRegionHost);
  document.body.appendChild(dragRegionHost);

  const navigationHost = document.createElement('div');
  navigationHost.id = 'kawaicord-navigation-controls';
  navigationHost.setAttribute('role', 'group');
  navigationHost.setAttribute('aria-label', 'Navigation controls');
  lockNavigationHost(navigationHost);
  const navigationShadow = navigationHost.attachShadow({ mode: 'closed' });
  const navigationStyle = document.createElement('style');
  navigationStyle.textContent = KAWAICORD_WINDOW_CONTROLS_CSS;
  const navigationControls = document.createElement('div');
  navigationControls.className = 'navigation';
  navigationControls.innerHTML = `
    <button type="button" aria-label="Go back" title="Go back"><span class="icon back-icon"></span></button>
    <button type="button" aria-label="Go forward" title="Go forward"><span class="icon forward-icon"></span></button>
  `;
  navigationShadow.append(navigationStyle, navigationControls);
  document.body.appendChild(navigationHost);

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
  const [backButton, forwardButton] = Array.from(
    navigationControls.querySelectorAll<HTMLButtonElement>('button')
  );
  const applyWindowState = (state: {
    maximized?: boolean;
    focused?: boolean;
    backgrounded?: boolean;
  }) => {
    const maximized = Boolean(state.maximized);
    host.dataset.maximized = String(maximized);
    host.dataset.focused = String(state.focused !== false);
    document.body.dataset.kawaicordMaximized = String(maximized);
    applyBackgroundState(Boolean(state.backgrounded));
    const label = maximized ? 'Restore' : 'Maximize';
    maximizeButton.setAttribute('aria-label', label);
    maximizeButton.setAttribute('title', label);
  };
  const syncWindowState = async () => {
    const state = await ipcRenderer.invoke('window:getState') as {
      maximized?: boolean;
      focused?: boolean;
      backgrounded?: boolean;
    };
    applyWindowState(state);
  };

  minimizeButton.addEventListener('click', () => ipcRenderer.send('window:minimize'));
  maximizeButton.addEventListener('click', () => ipcRenderer.send('window:maximize'));
  closeButton.addEventListener('click', () => ipcRenderer.send('window:close'));
  backButton.addEventListener('click', () => ipcRenderer.send('window:navigateBack'));
  forwardButton.addEventListener('click', () => ipcRenderer.send('window:navigateForward'));
  ipcRenderer.on('window:stateChanged', (_event, state) => applyWindowState(state || {}));
  const applyNavigationState = (state: { canGoBack?: boolean; canGoForward?: boolean }) => {
    backButton.disabled = !state.canGoBack;
    forwardButton.disabled = !state.canGoForward;
  };
  ipcRenderer.on('window:navigationState', (_event, state) => applyNavigationState(state || {}));
  ipcRenderer.on('window:backgroundedChanged', (_event, backgrounded) => {
    applyBackgroundState(Boolean(backgrounded));
  });

  let guardFrame: number | null = null;
  let protectedBar: HTMLElement | null = null;
  const protectedBarObserver = new MutationObserver(() => scheduleGuard());
  const protectedBarResizeObserver = new ResizeObserver(() => scheduleGuard());
  const enforceLocks = () => {
    guardFrame = null;
    if (rendererBackgrounded) return;
    if (!globalStyle.isConnected) document.head.appendChild(globalStyle);
    const nativeAppBar = lockNativeAppBar();
    if (!nativeAppBar && protectedBar && !protectedBar.isConnected) {
      protectedBar = null;
      protectedBarObserver.disconnect();
      protectedBarResizeObserver.disconnect();
      mountObserver.observe(document.body, { childList: true, subtree: true });
    }
    if (nativeAppBar && nativeAppBar.bar !== protectedBar) {
      protectedBar = nativeAppBar.bar;
      mountObserver.disconnect();
      protectedBarObserver.disconnect();
      protectedBarResizeObserver.disconnect();
      for (const element of [nativeAppBar.bar, nativeAppBar.title, nativeAppBar.trailing]) {
        protectedBarObserver.observe(element, {
          attributes: true,
          attributeFilter: ['class', 'style', 'hidden']
        });
        protectedBarResizeObserver.observe(element);
      }
      const barParent = nativeAppBar.bar.parentElement;
      if (barParent) protectedBarObserver.observe(barParent, { childList: true });
      protectedBarResizeObserver.observe(host);
    }
  };
  const scheduleGuard = () => {
    if (rendererBackgrounded) return;
    if (guardFrame === null) guardFrame = window.requestAnimationFrame(enforceLocks);
  };

  const headObserver = new MutationObserver(scheduleGuard);
  headObserver.observe(document.head, { childList: true, subtree: true });
  const mountObserver = new MutationObserver(scheduleGuard);
  mountObserver.observe(document.body, { childList: true, subtree: true });

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
  protectedAttributeObserver.observe(navigationHost, {
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden']
  });
  protectedAttributeObserver.observe(dragRegionHost, {
    attributes: true,
    attributeFilter: ['class', 'style', 'hidden']
  });

  backgroundListeners.add(hidden => {
    if (hidden) {
      if (guardFrame !== null) window.cancelAnimationFrame(guardFrame);
      guardFrame = null;
      headObserver.disconnect();
      mountObserver.disconnect();
      protectedBarObserver.disconnect();
      protectedBarResizeObserver.disconnect();
    } else {
      protectedBar = null;
      headObserver.observe(document.head, { childList: true, subtree: true });
      mountObserver.observe(document.body, { childList: true, subtree: true });
      enforceLocks();
    }
  });
  enforceLocks();
  void syncWindowState();
  void ipcRenderer.invoke('window:getNavigationState').then(applyNavigationState);
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
    if (rendererBackgrounded) return;
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
    if (rendererBackgrounded) return;
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
  backgroundListeners.add(hidden => {
    if (hidden && updateTimer !== null) {
      window.clearTimeout(updateTimer);
      updateTimer = null;
    }
    if (!hidden) scheduleUpdate();
  });
  scheduleUpdate();
}

function initUnreadBadgeObserver() {
  let lastUnread = -1;
  const updateUnread = () => {
    const match = document.title.match(/^\(([\d,]+)\)/);
    const unread = match ? Number(match[1].replace(/,/g, '')) : 0;
    if (unread === lastUnread || !Number.isFinite(unread)) return;
    lastUnread = unread;
    ipcRenderer.send('window:setUnreadCount', unread);
  };

  const titleObserver = new MutationObserver(updateUnread);
  const watchTitle = () => {
    titleObserver.disconnect();
    const title = document.querySelector('title');
    if (title) titleObserver.observe(title, { childList: true, subtree: true, characterData: true });
    updateUnread();
  };
  // Stylesheet churn must not trigger badge IPC or title parsing.
  new MutationObserver(watchTitle).observe(document.head, { childList: true });
  watchTitle();
  updateUnread();
}

window.addEventListener('DOMContentLoaded', () => {
  injectSettingsCss();
  injectPerformanceCss();
  injectTitlebar();
  initThemeObserver();
  initUnreadBadgeObserver();
  void ensureClientModsInjected('DOM ready');
});

injectCompatibilityPatches();
injectBootSplash();
void ensureClientModsInjected('preload');
