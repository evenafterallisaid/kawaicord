import {
  app,
  BrowserWindow,
  crashReporter,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  net,
  protocol,
  screen,
  session,
  shell,
  Tray,
  utilityProcess
} from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { pathToFileURL } from 'url';
import { autoUpdater } from 'electron-updater';
import { getDetectables, addDetectable } from './detectables';
import { getRendererReloadRequest } from './reload';
import { restoreWindowState, StoredWindowState } from './window-state';

// Keep the stable acceleration paths enabled without overriding Chromium's
// GPU safety blocklist. Unsupported drivers should fall back instead of
// entering a GPU crash loop.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('enable-zero-copy');
app.commandLine.appendSwitch('enable-accelerated-video-decode');
app.commandLine.appendSwitch('webrtc-hw-encoding');
app.commandLine.appendSwitch('webrtc-hw-decoding');
app.commandLine.appendSwitch(
  'enable-features',
  'CanvasOopRasterization,WebRtcHWEncoding,WebRtcHWDecoding,AcceleratedVideoEncoder,AcceleratedVideoDecoder,ZeroCopyDesktopCapture'
);

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kawaicord',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      bypassCSP: true,
      stream: true
    }
  }
]);

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let isQuitting = false;
let restartInProgress = false;
let windowStateSaveTimer: NodeJS.Timeout | null = null;
let appliedBackgroundThrottling: boolean | null = null;
let appliedRendererBackgrounded: boolean | null = null;
let rendererInjectionReady = false;
let injectionWatchdogTimer: NodeJS.Timeout | null = null;
let discordHealthWatchdogTimer: NodeJS.Timeout | null = null;
let discordRecoveryAttempts = 0;
let discordRendererReady = false;
let rendererRecoveryTimer: NodeJS.Timeout | null = null;
let unresponsiveDialogOpen = false;
let modBundleRefreshTimer: NodeJS.Timeout | null = null;
let sessionSafeMode = process.argv.includes('--safe-mode');
const smokeTestMode = process.argv.includes('--smoke-test');
const restartSmokeTestMode = process.argv.includes('--restart-smoke-test');
let rendererCrashCount = 0;
let rendererCrashWindowStartedAt = 0;
const vencordDataPath = path.join(app.getPath('userData'), 'vencord_data');
const configPath = path.join(app.getPath('userData'), 'kawaicord_config.json');
const recoveryPath = path.join(app.getPath('userData'), 'kawaicord_recovery.json');
const logPath = path.join(app.getPath('userData'), 'kawaicord.log');
const windowStatePath = path.join(app.getPath('userData'), 'kawaicord_window.json');
const discordPartition = 'persist:discord';

function clearInjectionWatchdog() {
  if (injectionWatchdogTimer) {
    clearTimeout(injectionWatchdogTimer);
    injectionWatchdogTimer = null;
  }
}

function clearDiscordHealthWatchdog() {
  if (discordHealthWatchdogTimer) {
    clearTimeout(discordHealthWatchdogTimer);
    discordHealthWatchdogTimer = null;
  }
}

function markRendererNavigation() {
  rendererInjectionReady = false;
  discordRendererReady = false;
  clearInjectionWatchdog();
  clearDiscordHealthWatchdog();
}

function requestRendererInjection(reason: string) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('kawaicord:ensureInjection', reason);
  clearInjectionWatchdog();
  injectionWatchdogTimer = setTimeout(() => {
    injectionWatchdogTimer = null;
    if (!rendererInjectionReady && mainWindow && !mainWindow.isDestroyed()) {
      appendLog('warn', `Renderer injection was not ready after navigation (${reason}); requesting a retry.`);
      mainWindow.webContents.send('kawaicord:ensureInjection', 'main-process watchdog');
    }
  }, 8000);
}

function reloadDiscord(reason: string, ignoreCache = false) {
  if (!mainWindow || mainWindow.isDestroyed() || isQuitting || restartInProgress) return;
  markRendererNavigation();
  appendLog('info', `Reloading Discord renderer (${reason}).`);
  if (ignoreCache) {
    mainWindow.webContents.reloadIgnoringCache();
  } else {
    mainWindow.webContents.reload();
  }
}

function getNavigationState() {
  const history = mainWindow?.webContents.navigationHistory;
  return {
    canGoBack: Boolean(history?.canGoBack()),
    canGoForward: Boolean(history?.canGoForward())
  };
}

function sendNavigationState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('window:navigationState', getNavigationState());
}

function isTrustedDiscordRenderer(event: Electron.IpcMainInvokeEvent) {
  try {
    const senderUrl = event.senderFrame?.url || event.sender.getURL();
    const hostname = new URL(senderUrl).hostname;
    return hostname === 'discord.com' || hostname.endsWith('.discord.com');
  } catch {
    return false;
  }
}

function requireTrustedDiscordRenderer(event: Electron.IpcMainInvokeEvent) {
  if (!isTrustedDiscordRenderer(event)) {
    throw new Error('Update request rejected from an untrusted renderer.');
  }
}

function setUnreadOverlay(count: number) {
  if (!mainWindow || mainWindow.isDestroyed() || process.platform !== 'win32') return;
  if (count <= 0) {
    mainWindow.setOverlayIcon(null, 'No unread messages');
    return;
  }

  const label = count > 99 ? '99+' : String(count);
  const fontSize = label.length >= 3 ? 14 : label.length === 2 ? 17 : 20;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
    <circle cx="16" cy="16" r="15" fill="#f23f43" stroke="#ffffff" stroke-width="2"/>
    <text x="16" y="22" text-anchor="middle" font-family="Segoe UI,Arial,sans-serif" font-size="${fontSize}" font-weight="700" fill="#ffffff">${label}</text>
  </svg>`;
  const overlay = nativeImage.createFromDataURL(
    `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`
  ).resize({ width: 16, height: 16 });
  mainWindow.setOverlayIcon(overlay, `${count} unread messages`);
}

function armDiscordHealthWatchdog() {
  clearDiscordHealthWatchdog();
  discordHealthWatchdogTimer = setTimeout(() => {
    discordHealthWatchdogTimer = null;
    if (discordRendererReady || !mainWindow || mainWindow.isDestroyed() || isQuitting) return;

    discordRecoveryAttempts += 1;
    if (discordRecoveryAttempts === 1) {
      appendLog('warn', 'Discord UI did not mount after 20 seconds; retrying the renderer.');
      reloadDiscord('Discord UI health recovery');
      return;
    }

    if (discordRecoveryAttempts === 2) {
      sessionSafeMode = true;
      appendLog('warn', 'Discord UI still did not mount; retrying without Vencord/Equicord.');
      reloadDiscord('Discord UI recovery mode', true);
      return;
    }

    appendLog('error', 'Discord UI did not mount after automatic recovery attempts.');
    mainWindow.webContents.send('kawaicord:discordFailed');
  }, 20_000);
}

function updateWindowPerformance() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const isBackground = !mainWindow.isVisible() || mainWindow.isMinimized();
  if (appliedBackgroundThrottling !== config.backgroundThrottling) {
    mainWindow.webContents.setBackgroundThrottling(config.backgroundThrottling);
    appliedBackgroundThrottling = config.backgroundThrottling;
  }
  const rendererBackgrounded = config.performanceMode && isBackground;
  if (appliedRendererBackgrounded !== rendererBackgrounded) {
    mainWindow.webContents.send('window:backgroundedChanged', rendererBackgrounded);
    appliedRendererBackgrounded = rendererBackgrounded;
  }
}

type ValidMod = 'vencord' | 'equicord';
type KawaicordConfig = {
  activeMod: ValidMod;
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

function isValidMod(mod: unknown): mod is ValidMod {
  return mod === 'vencord' || mod === 'equicord';
}

function normalizeActiveMod(activeMod: unknown): ValidMod {
  return isValidMod(activeMod) ? activeMod : 'vencord';
}

const modBundleSources = {
  vencord: {
    js: 'https://github.com/Vendicated/Vencord/releases/download/devbuild/browser.js',
    css: 'https://github.com/Vendicated/Vencord/releases/download/devbuild/browser.css'
  },
  equicord: {
    js: 'https://github.com/Equicord/Equicord/releases/download/latest/browser.js',
    css: 'https://github.com/Equicord/Equicord/releases/download/latest/browser.css'
  },
  shelter: {
    js: 'https://raw.githubusercontent.com/uwu/shelter-builds/main/shelter.js'
  }
} as const;

async function readFirstExisting(filePaths: string[]): Promise<string> {
  for (const filePath of filePaths) {
    try {
      return await fs.promises.readFile(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  return '';
}

function appendLog(level: string, message: string, error?: unknown) {
  const detail = error instanceof Error ? error.stack ?? error.message : error ? String(error) : '';
  const line = `[${new Date().toISOString()}] [${level}] ${message}${detail ? `\n${detail}` : ''}\n`;

  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > 2 * 1024 * 1024) {
      fs.copyFileSync(logPath, `${logPath}.1`);
      fs.truncateSync(logPath, 0);
    }
    fs.appendFileSync(logPath, line, 'utf-8');
  } catch {
    // Logging must never prevent the app from starting or shutting down.
  }
}

function guardOutputPipes() {
  for (const stream of [process.stdout, process.stderr]) {
    stream?.on('error', error => {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') {
        appendLog('warn', 'A process output stream failed.', error);
      }
    });
  }
}

function updateRecoveryState(cleanExit: boolean) {
  try {
    fs.writeFileSync(recoveryPath, JSON.stringify({ cleanExit, updatedAt: Date.now() }, null, 2));
  } catch (error) {
    appendLog('warn', 'Could not update recovery state.', error);
  }
}

function readStoredWindowState(): StoredWindowState {
  try {
    return JSON.parse(fs.readFileSync(windowStatePath, 'utf-8')) as StoredWindowState;
  } catch {
    return {};
  }
}

function saveWindowState() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  try {
    const bounds = mainWindow.getNormalBounds();
    const state: StoredWindowState = {
      ...bounds,
      maximized: mainWindow.isMaximized()
    };
    fs.writeFileSync(windowStatePath, JSON.stringify(state, null, 2), 'utf-8');
  } catch (error) {
    appendLog('warn', 'Could not save window state.', error);
  }
}

function queueWindowStateSave() {
  if (windowStateSaveTimer) clearTimeout(windowStateSaveTimer);
  windowStateSaveTimer = setTimeout(() => {
    windowStateSaveTimer = null;
    saveWindowState();
  }, 350);
}

function shouldStartInSafeMode() {
  if (sessionSafeMode) return true;

  try {
    const previous = JSON.parse(fs.readFileSync(recoveryPath, 'utf-8')) as {
      cleanExit?: boolean;
      updatedAt?: number;
    };
    return previous.cleanExit === false && Date.now() - Number(previous.updatedAt ?? 0) < 2 * 60 * 1000;
  } catch {
    return false;
  }
}

async function fetchTextWithTimeout(url: string, timeoutMs = 15000): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': `Kawaicord/${app.getVersion()}`
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const text = await response.text();
    if (!text.trim()) {
      throw new Error('Empty response');
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

function writeIfChanged(filePath: string, content: string): boolean {
  if (fs.existsSync(filePath)) {
    const existing = fs.readFileSync(filePath, 'utf-8');
    if (existing === content) {
      return false;
    }
  }

  const temporaryPath = `${filePath}.download`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(temporaryPath, content, 'utf-8');
  fs.copyFileSync(temporaryPath, filePath);
  fs.unlinkSync(temporaryPath);
  return true;
}

function isPlausibleBundle(fileName: string, content: string) {
  const minimumSize = fileName.endsWith('.css') ? 256 : 1024;
  const prefix = content.slice(0, 512).toLowerCase();
  return content.length >= minimumSize && !prefix.includes('<!doctype html') && !prefix.includes('<html');
}

async function refreshModBundles() {
  const activeSource = modBundleSources[config.activeMod];
  const bundleFiles: Array<{ fileName: string; url: string }> = [
    { fileName: 'shelter.js', url: modBundleSources.shelter.js }
  ];

  if (config.autoUpdateMods) {
    bundleFiles.push(
      { fileName: `${config.activeMod}.js`, url: activeSource.js },
      { fileName: `${config.activeMod}.css`, url: activeSource.css }
    );
  }

  await Promise.all(bundleFiles.map(async (bundleFile) => {
    const targetPath = path.join(app.getPath('userData'), bundleFile.fileName);
    const refreshInterval = bundleFile.fileName === 'shelter.js' ? 24 : 6;

    if (
      fs.existsSync(targetPath) &&
      Date.now() - fs.statSync(targetPath).mtimeMs < refreshInterval * 60 * 60 * 1000
    ) {
      return;
    }

    try {
      const content = await fetchTextWithTimeout(bundleFile.url, 10000);
      if (!isPlausibleBundle(bundleFile.fileName, content)) {
        throw new Error('Downloaded file did not look like a valid bundle');
      }
      const updated = writeIfChanged(targetPath, content);
      if (updated) {
        console.log('[Mod Loader] Updated ' + bundleFile.fileName);
        appendLog('info', `Updated ${bundleFile.fileName}.`);
      }
    } catch (error) {
      console.warn('[Mod Loader] Failed to update ' + bundleFile.fileName + ':', error);
      appendLog('warn', `Failed to update ${bundleFile.fileName}; using cached or bundled fallback.`, error);
    }
  }));
}

function scheduleModBundleRefresh(delayMs: number) {
  if (modBundleRefreshTimer) clearTimeout(modBundleRefreshTimer);
  modBundleRefreshTimer = setTimeout(() => {
    modBundleRefreshTimer = null;
    if (!isQuitting) void refreshModBundles();
  }, delayMs);
  modBundleRefreshTimer.unref();
}

// Default Config
const defaultConfig = {
  activeMod: 'vencord' as ValidMod,
  performanceMode: true,
  backgroundThrottling: false,
  arRPC: true,
  trayEnabled: true,
  trayIconAuto: true,
  trayIconTheme: 'dark' as 'dark' | 'light',
  startAtLogin: false,
  minimizeToTray: false,
  autoUpdateMods: true,
  autoUpdateApp: true
};

function normalizeConfig(raw: unknown): KawaicordConfig {
  const value = raw && typeof raw === 'object' ? raw as Partial<KawaicordConfig> : {};
  const booleanValue = <K extends keyof KawaicordConfig>(key: K) =>
    typeof value[key] === 'boolean' ? value[key] as boolean : defaultConfig[key] as boolean;

  return {
    activeMod: normalizeActiveMod(value.activeMod),
    performanceMode: booleanValue('performanceMode'),
    backgroundThrottling: booleanValue('backgroundThrottling'),
    arRPC: booleanValue('arRPC'),
    trayEnabled: booleanValue('trayEnabled'),
    trayIconAuto: booleanValue('trayIconAuto'),
    trayIconTheme: value.trayIconTheme === 'light' ? 'light' : 'dark',
    startAtLogin: booleanValue('startAtLogin'),
    minimizeToTray: booleanValue('minimizeToTray'),
    autoUpdateMods: booleanValue('autoUpdateMods'),
    autoUpdateApp: booleanValue('autoUpdateApp')
  };
}

// Load Config
let config: KawaicordConfig = { ...defaultConfig };
if (fs.existsSync(configPath)) {
  try {
    config = normalizeConfig(JSON.parse(fs.readFileSync(configPath, 'utf-8')));
  } catch (e) {
    console.error('Failed to load config:', e);
  }
} else {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
}

fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

type AppUpdatePhase =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error';

type AppUpdateStatus = {
  phase: AppUpdatePhase;
  currentVersion: string;
  availableVersion?: string;
  percent?: number;
  transferred?: number;
  total?: number;
  message: string;
  checkedAt?: number;
};

const AUTO_UPDATE_INITIAL_DELAY_MS = 30_000;
const AUTO_UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
let automaticUpdateTimer: NodeJS.Timeout | null = null;
let updateCheckPromise: Promise<AppUpdateStatus> | null = null;
let updaterConfigured = false;
let appUpdateStatus: AppUpdateStatus = {
  phase: 'idle',
  currentVersion: app.getVersion(),
  message: 'Ready to check for updates.'
};

function appUpdaterSupported() {
  return process.platform === 'win32' && app.isPackaged;
}

function publishAppUpdateStatus(next: AppUpdateStatus) {
  appUpdateStatus = next;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('kawaicord:updateStatus', appUpdateStatus);
  }
}

function updateErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s+/g, ' ').trim().slice(0, 300) || 'Unknown update error';
}

function configureAppUpdater() {
  if (updaterConfigured) return;
  updaterConfigured = true;

  if (!appUpdaterSupported()) {
    publishAppUpdateStatus({
      phase: 'disabled',
      currentVersion: app.getVersion(),
      message: 'App updates are available in installed builds.'
    });
    return;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.disableWebInstaller = true;

  autoUpdater.on('checking-for-update', () => {
    publishAppUpdateStatus({
      phase: 'checking',
      currentVersion: app.getVersion(),
      message: 'Checking GitHub Releases…'
    });
  });

  autoUpdater.on('update-available', info => {
    appendLog('info', `Kawaicord ${info.version} is available; downloading it in the background.`);
    publishAppUpdateStatus({
      phase: 'available',
      currentVersion: app.getVersion(),
      availableVersion: info.version,
      message: `Kawaicord ${info.version} is available. Starting download…`,
      checkedAt: Date.now()
    });
  });

  autoUpdater.on('update-not-available', info => {
    publishAppUpdateStatus({
      phase: 'up-to-date',
      currentVersion: app.getVersion(),
      availableVersion: info.version,
      message: 'Kawaicord is up to date.',
      checkedAt: Date.now()
    });
  });

  autoUpdater.on('download-progress', progress => {
    publishAppUpdateStatus({
      phase: 'downloading',
      currentVersion: app.getVersion(),
      availableVersion: appUpdateStatus.availableVersion,
      percent: Math.max(0, Math.min(100, progress.percent)),
      transferred: progress.transferred,
      total: progress.total,
      message: `Downloading Kawaicord ${appUpdateStatus.availableVersion ?? 'update'}…`
    });
  });

  autoUpdater.on('update-downloaded', info => {
    appendLog('info', `Kawaicord ${info.version} downloaded and ready to install.`);
    publishAppUpdateStatus({
      phase: 'downloaded',
      currentVersion: app.getVersion(),
      availableVersion: info.version,
      percent: 100,
      message: `Kawaicord ${info.version} is ready. Restart to install it.`,
      checkedAt: Date.now()
    });
  });

  autoUpdater.on('error', error => {
    const message = updateErrorMessage(error);
    appendLog('warn', 'App update failed.', error);
    publishAppUpdateStatus({
      phase: 'error',
      currentVersion: app.getVersion(),
      availableVersion: appUpdateStatus.availableVersion,
      message: `Update failed: ${message}`,
      checkedAt: Date.now()
    });
  });
}

async function checkForAppUpdates(): Promise<AppUpdateStatus> {
  configureAppUpdater();
  if (!appUpdaterSupported()) return appUpdateStatus;
  if (updateCheckPromise) return updateCheckPromise;
  if (appUpdateStatus.phase === 'downloaded') return appUpdateStatus;

  updateCheckPromise = (async () => {
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      const message = updateErrorMessage(error);
      appendLog('warn', 'Could not check GitHub Releases for an app update.', error);
      publishAppUpdateStatus({
        phase: 'error',
        currentVersion: app.getVersion(),
        message: `Could not check for updates: ${message}`,
        checkedAt: Date.now()
      });
    }
    return appUpdateStatus;
  })();

  try {
    return await updateCheckPromise;
  } finally {
    updateCheckPromise = null;
  }
}

function clearAutomaticUpdateTimer() {
  if (!automaticUpdateTimer) return;
  clearTimeout(automaticUpdateTimer);
  automaticUpdateTimer = null;
}

function scheduleAutomaticUpdateCheck(delay = AUTO_UPDATE_INITIAL_DELAY_MS) {
  clearAutomaticUpdateTimer();
  if (!config.autoUpdateApp || !appUpdaterSupported() || isQuitting) return;

  automaticUpdateTimer = setTimeout(() => {
    automaticUpdateTimer = null;
    void checkForAppUpdates().finally(() => {
      scheduleAutomaticUpdateCheck(AUTO_UPDATE_INTERVAL_MS);
    });
  }, delay);
  automaticUpdateTimer.unref();
}

async function installDownloadedAppUpdate() {
  if (!appUpdaterSupported() || appUpdateStatus.phase !== 'downloaded' || restartInProgress) {
    return false;
  }

  restartInProgress = true;
  isQuitting = true;
  clearAutomaticUpdateTimer();
  stopRPC();
  saveWindowState();

  try {
    await Promise.race([
      session.fromPartition(discordPartition).flushStorageData(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('Storage flush timed out')), 2500);
      })
    ]);
  } catch (error) {
    appendLog('warn', 'Could not flush Discord storage before installing the update.', error);
  }

  try {
    updateRecoveryState(true);
    autoUpdater.quitAndInstall(false, true);
    return true;
  } catch (error) {
    appendLog('error', 'Could not launch the downloaded update.', error);
    restartInProgress = false;
    isQuitting = false;
    publishAppUpdateStatus({
      ...appUpdateStatus,
      phase: 'error',
      message: `Could not install the update: ${updateErrorMessage(error)}`
    });
    scheduleAutomaticUpdateCheck(AUTO_UPDATE_INTERVAL_MS);
    return false;
  }
}

if (!fs.existsSync(vencordDataPath)) {
  fs.mkdirSync(vencordDataPath, { recursive: true });
}

// Apply Start at Login
app.setLoginItemSettings({
  openAtLogin: config.startAtLogin,
  path: app.getPath('exe')
});

async function setupVencordInjection() {
  console.log('Setting up Discord header patches...');
  try {
    const ses = session.fromPartition(discordPartition);

    ses.webRequest.onBeforeRequest({
      urls: [
        'https://discord.com/api/*/science*',
        'https://*.discord.com/api/*/science*',
        'https://sentry.io/*',
        'https://*.sentry.io/*'
      ]
    }, (_details, callback) => callback({ cancel: true }));

    ses.webRequest.onHeadersReceived({
      urls: [
        'https://discord.com/app*',
        'https://discord.com/channels/*',
        'https://discord.com/login*',
        'https://discord.com/register*'
      ]
    }, (details, callback) => {
      const headers = { ...details.responseHeaders };

      if (details.resourceType === 'mainFrame') {
        Object.keys(headers).forEach(key => {
          if (key.toLowerCase().startsWith('content-security-policy')) {
            delete headers[key];
          }
        });
      }

      callback({ responseHeaders: headers });
    });
    console.log('Discord header patches ready.');
  } catch (error) {
    console.error('Error setting up Discord header patches:', error);
  }
}

let rpcChild: Electron.UtilityProcess | null = null;
let rpcRestartTimer: ReturnType<typeof setTimeout> | undefined;
let processList: any[] = [];

function startRPC(window: BrowserWindow) {
    if (!config.arRPC) return;
    stopRPC();

    const child = utilityProcess.fork(path.join(__dirname, "rpc.js"), undefined, {
        env: { detectables: JSON.stringify(getDetectables()) },
    });

    child.on("spawn", () => {
        console.log("[arRPC] process started");
    });
    rpcChild = child;

    rpcChild.on("message", (message) => {
        if (rpcChild !== child) return;
        try {
          const json = JSON.parse(String(message));
          if (json.type === "invite") {
              console.log("[arRPC] Invite received:", json.code);
          } else if (json.type === "activity" && !window.isDestroyed()) {
              window.webContents.send("rpc", json.data);
          } else if (json.type === "processList") {
              processList = json.data;
          }
        } catch (error) {
          appendLog('warn', 'Ignored an invalid arRPC message.', error);
        }
    });

    rpcChild.on("exit", (code) => {
        if (rpcChild !== child) return;
        console.log("[arRPC] process exited");
        rpcChild = null;
        if (!isQuitting && config.arRPC && code !== 0 && mainWindow) {
          rpcRestartTimer = setTimeout(() => {
            rpcRestartTimer = undefined;
            if (!isQuitting && config.arRPC && !rpcChild && mainWindow && !mainWindow.isDestroyed()) startRPC(mainWindow);
          }, 3000);
        }
    });
}

function stopRPC() {
    clearTimeout(rpcRestartTimer);
    rpcRestartTimer = undefined;
    if (rpcChild) {
        const child = rpcChild;
        rpcChild = null;
        child.kill();
    }
}

async function shutdownForRestart() {
  if (appUpdateStatus.phase === 'downloaded') {
    await installDownloadedAppUpdate();
    return;
  }
  if (restartInProgress) return;
  restartInProgress = true;
  isQuitting = true;
  appendLog('info', 'Restart requested.');

  stopRPC();
  clearInjectionWatchdog();
  clearDiscordHealthWatchdog();
  if (rendererRecoveryTimer) {
    clearTimeout(rendererRecoveryTimer);
    rendererRecoveryTimer = null;
  }

  try {
    await Promise.race([
      session.fromPartition(discordPartition).flushStorageData(),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('Storage flush timed out')), 2500);
      })
    ]);
  } catch (error) {
    appendLog('warn', 'Could not flush Discord storage before restart.', error);
  }

  const relaunchArgs = process.argv
    .slice(1)
    .filter(arg => arg !== '--safe-mode' && arg !== '--restart-smoke-test');
  if (restartSmokeTestMode) relaunchArgs.push('--smoke-test');

  try {
    app.relaunch({ args: relaunchArgs });
  } catch (error) {
    appendLog('error', 'Could not schedule the replacement process.', error);
    isQuitting = false;
    restartInProgress = false;
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (config.arRPC) startRPC(mainWindow);
      requestRendererInjection('restart recovery');
      void dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Kawaicord could not restart',
        message: 'The replacement process could not be started.',
        detail: `Kawaicord is still running. Try again or quit it manually.\n\nLog: ${logPath}`,
        buttons: ['OK'],
        noLink: true
      });
    }
    return;
  }

  saveWindowState();
  updateRecoveryState(true);
  tray?.destroy();
  tray = null;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeAllListeners('close');
    mainWindow.destroy();
    mainWindow = null;
  }
  app.exit(0);
}

function getTrayIconPath(theme: string) {
    const iconName = theme === 'light' ? 'tray-light.png' : 'tray-dark.png';
    return path.join(__dirname, '..', 'icons', iconName);
}

function setupKawaicordProtocol() {
  protocol.handle('kawaicord', async (request) => {
    try {
      const url = new URL(request.url);

      if (url.hostname === 'plugins') {
        const pathParts = url.pathname.split('/').filter(Boolean);
        if (pathParts.length < 2) {
          return new Response('bad', { status: 400, headers: { 'content-type': 'text/plain' } });
        }

        const pluginName = pathParts[0];
        const pluginFile = pathParts.slice(1).join('/');
        const pluginsRoot = path.join(__dirname, '..', 'plugins');
        const pluginRoot = path.resolve(pluginsRoot, pluginName);
        const filePath = path.resolve(pluginRoot, path.normalize(pluginFile));
        const relativePath = path.relative(pluginRoot, filePath);

        if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
          return new Response('bad', { status: 400, headers: { 'content-type': 'text/plain' } });
        }

        if (!fs.existsSync(filePath)) {
          return new Response('not found', { status: 404, headers: { 'content-type': 'text/plain' } });
        }

        return net.fetch(pathToFileURL(filePath).toString());
      }

      return new Response('bad', { status: 400, headers: { 'content-type': 'text/plain' } });
    } catch (error) {
      console.error('Protocol error:', error);
      return new Response('internal error', { status: 500, headers: { 'content-type': 'text/plain' } });
    }
  });
}

function buildTrayContextMenu(icon: Electron.NativeImage) {
    return Menu.buildFromTemplate([
        {
            label: `Kawaicord ${app.getVersion()}`,
            enabled: false,
            icon: icon
        },
        {
            type: "separator",
        },
        {
            label: "Open Kawaicord",
            click() {
                mainWindow?.show();
            },
        },
        {
            type: "separator",
        },
        {
            label: "Restart Kawaicord",
            click() {
                void shutdownForRestart();
            },
        },
        {
            label: "Quit Kawaicord",
            click() {
                isQuitting = true;
                app.quit();
            },
        },
    ]);
}

function updateTrayIcon(theme: string) {
    if (!tray) return;
    const iconPath = getTrayIconPath(theme);
    if (fs.existsSync(iconPath)) {
        const icon = nativeImage.createFromPath(iconPath).resize({ height: 16 });
        tray.setImage(icon);
        tray.setContextMenu(buildTrayContextMenu(icon));
    }
}

function createTray() {
    if (!config.trayEnabled) return;
    if (tray) return; // Already exists

    const initialTheme = config.trayIconAuto ? 'dark' : config.trayIconTheme;
    const iconPath = getTrayIconPath(initialTheme);
    const fallbackIconPath = path.join(__dirname, '..', 'icons', 'icon.png');
    const trayIcon = nativeImage
      .createFromPath(fs.existsSync(iconPath) ? iconPath : fallbackIconPath)
      .resize({ width: 16, height: 16 });

    tray = new Tray(trayIcon);
    tray.setContextMenu(buildTrayContextMenu(trayIcon));
    tray.setToolTip("Kawaicord");
    tray.on("click", () => {
        mainWindow?.show();
    });
}

function createWindow() {
  console.log('Creating window...');
  appliedBackgroundThrottling = null;
  appliedRendererBackgrounded = null;
  discordRendererReady = false;
  discordRecoveryAttempts = 0;
  clearDiscordHealthWatchdog();
  const appIconPath = path.join(__dirname, '..', 'icons', 'icon.png');
  const restoredState = restoreWindowState(
    readStoredWindowState(),
    screen.getAllDisplays().map(display => display.workArea)
  );
  mainWindow = new BrowserWindow({
    width: restoredState.width,
    height: restoredState.height,
    x: restoredState.x,
    y: restoredState.y,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
      webviewTag: false,
      sandbox: false,
      partition: discordPartition,
      webSecurity: true,
      backgroundThrottling: config.backgroundThrottling
    },
    title: 'Kawaicord',
    icon: appIconPath,
    backgroundColor: '#111214',
    show: false,
    frame: false, // Custom titlebar
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    autoHideMenuBar: true
  });

  void mainWindow.loadURL('https://discord.com/app').catch(error => {
    if (isQuitting || restartInProgress) return;
    appendLog('error', 'Could not begin loading Discord.', error);
  });

  startRPC(mainWindow);
  createTray();

  mainWindow.once('ready-to-show', () => {
    if (!smokeTestMode) mainWindow?.show();
  });

  if (restoredState.maximized) mainWindow.maximize();

  const sendWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:stateChanged', {
      maximized: mainWindow.isMaximized(),
      focused: mainWindow.isFocused(),
      backgrounded: config.performanceMode && (!mainWindow.isVisible() || mainWindow.isMinimized())
    });
  };

  mainWindow.on('show', updateWindowPerformance);
  mainWindow.on('hide', updateWindowPerformance);
  mainWindow.on('minimize', updateWindowPerformance);
  mainWindow.on('restore', updateWindowPerformance);
  mainWindow.on('focus', sendWindowState);
  mainWindow.on('blur', sendWindowState);
  mainWindow.on('move', queueWindowStateSave);
  mainWindow.on('resize', queueWindowStateSave);
  mainWindow.on('maximize', () => {
    queueWindowStateSave();
    sendWindowState();
  });
  mainWindow.on('unmaximize', () => {
    queueWindowStateSave();
    sendWindowState();
  });

  mainWindow.webContents.on('before-input-event', (event, input) => {
    const reloadRequest = getRendererReloadRequest(input);
    if (!reloadRequest) return;

    event.preventDefault();
    reloadDiscord(reloadRequest.reason, reloadRequest.ignoreCache);
  });

  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) markRendererNavigation();
  });

  mainWindow.webContents.on('did-finish-load', () => {
    requestRendererInjection('page finished loading');
    armDiscordHealthWatchdog();
    sendWindowState();
    sendNavigationState();
  });

  mainWindow.webContents.on('did-navigate', (event, url) => {
    console.log('Navigated to:', url);
    sendNavigationState();
  });
  mainWindow.webContents.on('did-navigate-in-page', sendNavigationState);

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    appendLog('error', `Discord failed to load (${code}: ${description}) at ${url}.`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting) return;
    if (details.reason === 'clean-exit') return;

    const now = Date.now();
    if (now - rendererCrashWindowStartedAt > 60_000) {
      rendererCrashWindowStartedAt = now;
      rendererCrashCount = 0;
    }
    rendererCrashCount += 1;
    appendLog('error', `Renderer exited: ${details.reason} (${details.exitCode}).`);

    if (rendererCrashCount >= 2) {
      sessionSafeMode = true;
      appendLog('warn', 'Repeated renderer failure; recovering without Vencord/Equicord for this session.');
    }

    if (rendererRecoveryTimer) clearTimeout(rendererRecoveryTimer);
    rendererRecoveryTimer = setTimeout(() => {
      rendererRecoveryTimer = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        reloadDiscord('renderer recovery', true);
      }
    }, 1000);
  });

  mainWindow.on('unresponsive', async () => {
    if (unresponsiveDialogOpen) return;
    appendLog('warn', 'Renderer became unresponsive.');
    if (!mainWindow || mainWindow.isDestroyed() || isQuitting) return;
    unresponsiveDialogOpen = true;
    try {
      const result = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Kawaicord is not responding',
        message: 'Discord stopped responding.',
        detail: 'You can wait, reload the Discord view, or restart Kawaicord in recovery mode.',
        buttons: ['Wait', 'Reload', 'Recovery restart'],
        defaultId: 0,
        cancelId: 0,
        noLink: true
      });

      if (result.response === 1) {
        reloadDiscord('unresponsive recovery', true);
      } else if (result.response === 2) {
        sessionSafeMode = true;
        app.relaunch({ args: [...process.argv.slice(1).filter(arg => arg !== '--safe-mode'), '--safe-mode'] });
        isQuitting = true;
        stopRPC();
        updateRecoveryState(true);
        app.exit(0);
      }
    } finally {
      unresponsiveDialogOpen = false;
    }
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    const parsedUrl = new URL(url);
    if (!parsedUrl.hostname.endsWith('discord.com')) {
      event.preventDefault();
      if (url.startsWith('https:') || url.startsWith('http:') || url.startsWith('mailto:')) {
        void shell.openExternal(url);
      }
    }
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'about:blank' || url.startsWith('blob:https://discord.com/')) {
      return { action: 'allow' };
    }

    if (url.startsWith('https:') || url.startsWith('http:') || url.startsWith('mailto:')) {
      void shell.openExternal(url);
    }

    return { action: 'deny' };
  });

  mainWindow.on('close', (e) => {
    saveWindowState();
    if (config.minimizeToTray && !isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  mainWindow.on('closed', () => {
    if (windowStateSaveTimer) {
      clearTimeout(windowStateSaveTimer);
      windowStateSaveTimer = null;
    }
    clearInjectionWatchdog();
    clearDiscordHealthWatchdog();
    if (rendererRecoveryTimer) {
      clearTimeout(rendererRecoveryTimer);
      rendererRecoveryTimer = null;
    }
    mainWindow = null;
  });

  updateWindowPerformance();
}

ipcMain.handle('kawaicord:getVersion', () => app.getVersion());
ipcMain.handle('kawaicord:reload', () => {
  reloadDiscord('Kawaicord API');
  return true;
});
ipcMain.handle('kawaicord:restart', () => {
  void shutdownForRestart();
  return true;
});
ipcMain.handle('kawaicord:getUpdateStatus', event => {
  requireTrustedDiscordRenderer(event);
  return appUpdateStatus;
});
ipcMain.handle('kawaicord:checkForUpdates', event => {
  requireTrustedDiscordRenderer(event);
  return checkForAppUpdates();
});
ipcMain.handle('kawaicord:installUpdate', event => {
  requireTrustedDiscordRenderer(event);
  return installDownloadedAppUpdate();
});
ipcMain.on('kawaicord:setTrayIcon', (event, theme) => updateTrayIcon(theme));
ipcMain.on('kawaicord:toggleTray', (event, enabled) => {
    if (enabled) {
        createTray();
    } else {
        if (tray) {
            tray.destroy();
            tray = null;
        }
    }
});
ipcMain.on('kawaicord:getOsRelease', (event) => event.returnValue = require('os').release());
ipcMain.on('kawaicord:getOsArch', (event) => event.returnValue = require('os').arch());
ipcMain.handle('vencord:getDataPath', () => vencordDataPath);

ipcMain.handle('kawaicord:getShelterBundle', async () => {
  const userDataJsPath = path.join(app.getPath('userData'), 'shelter.js');
  const bundledJsPath = path.join(__dirname, '..', 'shelter', 'shelter.js');

  return {
    enabled: true,
    js: await readFirstExisting([userDataJsPath, bundledJsPath])
  };
});

async function getModBundle(mod: 'vencord' | 'equicord', enabled: boolean) {
  if (!enabled || sessionSafeMode) return { enabled: false, mod, js: '', css: '' };
  const userDataJsPath = path.join(app.getPath('userData'), `${mod}.js`);
  const userDataCssPath = path.join(app.getPath('userData'), `${mod}.css`);
  const bundledJsPath = path.join(__dirname, '..', mod, `${mod}.js`);
  const bundledCssPath = path.join(__dirname, '..', mod, `${mod}.css`);

  return {
    enabled: enabled && !sessionSafeMode,
    mod,
    js: await readFirstExisting([userDataJsPath, bundledJsPath]),
    css: await readFirstExisting([userDataCssPath, bundledCssPath])
  };
}

ipcMain.handle('kawaicord:getVencordBundle', () => {
  return getModBundle('vencord', config.activeMod === 'vencord');
});

ipcMain.handle('kawaicord:getEquicordBundle', () => {
  return getModBundle('equicord', config.activeMod === 'equicord');
});

ipcMain.handle('kawaicord:getRuntimeStatus', () => ({
  activeMod: config.activeMod,
  safeMode: sessionSafeMode,
  logPath
}));

ipcMain.on('kawaicord:injectionStatus', (_event, status: {
  shelter?: boolean;
  mod?: string | null;
  restartHooks?: number;
  attempts?: number;
  reason?: string;
  error?: string | null;
}) => {
  const injectionSucceeded = Boolean(status.shelter && (sessionSafeMode || status.mod) && !status.error);
  if (injectionSucceeded) {
    rendererInjectionReady = true;
    clearInjectionWatchdog();
  }

  if (status.error) {
    appendLog('error', `Renderer injection attempt ${status.attempts ?? 1} failed: ${status.error}`);
  } else {
    const restartDetail = status.mod
      ? ` (${status.restartHooks ?? 0} restart calls routed)`
      : '';
    appendLog('info', `Renderer injection ready: Shelter + ${status.mod ?? 'recovery mode'}${restartDetail}.`);
    if (status.mod && !status.restartHooks) {
      appendLog('warn', `${status.mod} loaded without any restart-call hooks.`);
    }
  }

  if (smokeTestMode && injectionSucceeded) {
    setTimeout(() => {
      isQuitting = true;
      app.quit();
    }, 500);
  } else if (restartSmokeTestMode && injectionSucceeded) {
    setTimeout(() => void shutdownForRestart(), 500);
  }
});

ipcMain.on('kawaicord:discordReady', () => {
  if (discordRendererReady) return;
  discordRendererReady = true;
  discordRecoveryAttempts = 0;
  clearDiscordHealthWatchdog();
  appendLog('info', 'Discord UI ready.');
  // Let Discord finish its first paint before doing optional CDN work.
  scheduleModBundleRefresh(5_000);
});

ipcMain.handle('kawaicord:getConfig', () => config);
ipcMain.handle('kawaicord:setConfig', (_event, newConfig) => {
  const oldConfig = { ...config };
  const candidate = newConfig && typeof newConfig === 'object'
    ? newConfig as Partial<KawaicordConfig>
    : {};
  const booleanKeys: Array<keyof Pick<
    KawaicordConfig,
    'performanceMode' | 'backgroundThrottling' | 'arRPC' | 'trayEnabled' |
    'trayIconAuto' | 'startAtLogin' | 'minimizeToTray' | 'autoUpdateMods' | 'autoUpdateApp'
  >> = [
    'performanceMode',
    'backgroundThrottling',
    'arRPC',
    'trayEnabled',
    'trayIconAuto',
    'startAtLogin',
    'minimizeToTray',
    'autoUpdateMods',
    'autoUpdateApp'
  ];
  const nextConfig = { ...config };

  if (candidate.activeMod !== undefined) {
    nextConfig.activeMod = normalizeActiveMod(candidate.activeMod);
  }
  if (candidate.trayIconTheme === 'dark' || candidate.trayIconTheme === 'light') {
    nextConfig.trayIconTheme = candidate.trayIconTheme;
  }
  for (const key of booleanKeys) {
    if (typeof candidate[key] === 'boolean') nextConfig[key] = candidate[key];
  }

  config = nextConfig;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

  // Handle arRPC toggle
  if (oldConfig.arRPC !== config.arRPC) {
      if (config.arRPC) {
          if (mainWindow) startRPC(mainWindow);
      } else {
          stopRPC();
      }
  }

  // Handle Start at Login
  if (typeof candidate.startAtLogin !== 'undefined') {
      app.setLoginItemSettings({
          openAtLogin: config.startAtLogin,
          path: app.getPath('exe')
      });
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    updateWindowPerformance();
  }

  if (oldConfig.autoUpdateApp !== config.autoUpdateApp) {
    if (config.autoUpdateApp) {
      scheduleAutomaticUpdateCheck(5_000);
    } else {
      clearAutomaticUpdateTimer();
    }
  }

  return true;
});

// NOTE: Do NOT add VencordNative IPC handlers here!
// Vencord/Equicord bundles provide their own VencordNative object
// which uses browser storage APIs (IndexedDB/localStorage), not IPC.
// Adding IPC handlers causes "An object could not be cloned" errors
// because settings contain complex structures that can't be serialized.

// Window Controls
ipcMain.on('window:minimize', () => mainWindow?.minimize());
ipcMain.on('window:maximize', () => {
  if (mainWindow?.isMaximized()) {
    mainWindow.unmaximize();
  } else {
    mainWindow?.maximize();
  }
});
ipcMain.on('window:close', () => mainWindow?.close());
ipcMain.on('window:setUnreadCount', (_event, value) => {
  const count = Number.isFinite(value) ? Math.max(0, Math.min(9999, Math.floor(value))) : 0;
  setUnreadOverlay(count);
});
ipcMain.on('window:navigateBack', () => {
  const history = mainWindow?.webContents.navigationHistory;
  if (history?.canGoBack()) history.goBack();
});
ipcMain.on('window:navigateForward', () => {
  const history = mainWindow?.webContents.navigationHistory;
  if (history?.canGoForward()) history.goForward();
});
ipcMain.handle('window:getNavigationState', getNavigationState);
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized());
ipcMain.handle('window:getState', () => ({
  maximized: Boolean(mainWindow?.isMaximized()),
  focused: Boolean(mainWindow?.isFocused()),
  backgrounded: Boolean(
    config.performanceMode && mainWindow && (!mainWindow.isVisible() || mainWindow.isMinimized())
  )
}));
ipcMain.on('window:setBackgroundColor', (_event, color) => {
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) {
    mainWindow?.setBackgroundColor(color);
  }
});

// RPC Handlers
ipcMain.on('kawaicord:rpc:refreshProcessList', () => {
    rpcChild?.postMessage({ message: "refreshProcessList" });
});

ipcMain.on('kawaicord:rpc:getProcessList', (event) => {
    event.returnValue = processList;
});

ipcMain.on('kawaicord:rpc:addDetectable', (event, detectable) => {
    addDetectable(detectable);
});

ipcMain.on('kawaicord:rpc:getDetectables', (event) => {
    event.returnValue = getDetectables();
});


crashReporter.start({
  productName: 'Kawaicord',
  companyName: 'Kawaicord',
  submitURL: '',
  uploadToServer: false,
  compress: true
});

sessionSafeMode = shouldStartInSafeMode();
guardOutputPipes();

const hasSingleInstanceLock = app.requestSingleInstanceLock();
if (!hasSingleInstanceLock) {
  app.quit();
} else {
  updateRecoveryState(false);
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  void app.whenReady().then(async () => {
    console.log('App ready.');
    appendLog('info', `Starting Kawaicord ${app.getVersion()}${sessionSafeMode ? ' in recovery mode' : ''}.`);
    setupKawaicordProtocol();
    await setupVencordInjection();
    createWindow();
    configureAppUpdater();
    scheduleAutomaticUpdateCheck();
    // Bundled/cached mods make startup deterministic. This fallback refresh is
    // rescheduled sooner once Discord reports that its UI has mounted.
    scheduleModBundleRefresh(30_000);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  }).catch(error => {
    appendLog('error', 'Startup failed.', error);
    void dialog.showErrorBox('Kawaicord could not start', `${String(error)}\n\nLog: ${logPath}`);
    updateRecoveryState(true);
    app.exit(1);
  });
}

app.on('before-quit', () => {
  isQuitting = true;
  stopRPC();
  clearInjectionWatchdog();
  clearDiscordHealthWatchdog();
  clearAutomaticUpdateTimer();
  if (modBundleRefreshTimer) {
    clearTimeout(modBundleRefreshTimer);
    modBundleRefreshTimer = null;
  }
  if (rendererRecoveryTimer) {
    clearTimeout(rendererRecoveryTimer);
    rendererRecoveryTimer = null;
  }
  if (hasSingleInstanceLock) updateRecoveryState(true);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

process.on('uncaughtException', (error) => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') return;
  try {
    console.error('Uncaught exception:', error);
  } catch {
    // A detached GUI launch may no longer have a writable terminal pipe.
  }
  appendLog('error', 'Uncaught main-process exception.', error);
});

process.on('unhandledRejection', (error) => {
  try {
    console.error('Unhandled rejection:', error);
  } catch {
    // A detached GUI launch may no longer have a writable terminal pipe.
  }
  appendLog('error', 'Unhandled main-process rejection.', error);
});
