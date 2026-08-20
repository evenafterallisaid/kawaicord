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
import { getDetectables, addDetectable } from './detectables';
import { restoreWindowState, StoredWindowState } from './window-state';

// Fix for cache and network issues
// app.commandLine.appendSwitch('disable-http-cache'); // Removed as it causes slow loading
app.commandLine.appendSwitch('ignore-gpu-blocklist');
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
let appliedFrameRate: number | null = null;
let appliedBackgroundThrottling: boolean | null = null;
let sessionSafeMode = process.argv.includes('--safe-mode');
const smokeTestMode = process.argv.includes('--smoke-test');
const restartSmokeTestMode = process.argv.includes('--restart-smoke-test');
let rendererCrashCount = 0;
const vencordDataPath = path.join(app.getPath('userData'), 'vencord_data');
const configPath = path.join(app.getPath('userData'), 'kawaicord_config.json');
const recoveryPath = path.join(app.getPath('userData'), 'kawaicord_recovery.json');
const logPath = path.join(app.getPath('userData'), 'kawaicord.log');
const windowStatePath = path.join(app.getPath('userData'), 'kawaicord_window.json');
const discordPartition = 'persist:discord';

function updateWindowPerformance() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const isBackground = !mainWindow.isVisible() || mainWindow.isMinimized();
  const frameRate = config.performanceMode && isBackground ? 10 : 60;
  if (appliedFrameRate !== frameRate) {
    mainWindow.webContents.setFrameRate(frameRate);
    appliedFrameRate = frameRate;
  }
  if (appliedBackgroundThrottling !== config.backgroundThrottling) {
    mainWindow.webContents.setBackgroundThrottling(config.backgroundThrottling);
    appliedBackgroundThrottling = config.backgroundThrottling;
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

function readFirstExisting(filePaths: string[]): string {
  for (const filePath of filePaths) {
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
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
  autoUpdateMods: true
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
    autoUpdateMods: booleanValue('autoUpdateMods')
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

    ses.webRequest.onHeadersReceived((details, callback) => {
      const headers = { ...details.responseHeaders };

      // Only remove CSP from the main frame to improve performance
      if (details.resourceType === 'mainFrame') {
        Object.keys(headers).forEach(key => {
          if (key.toLowerCase().startsWith('content-security-policy')) {
            delete headers[key];
          }
        });
      }

      // Fix content-type for some resources if needed (like raw github)
      if (details.resourceType === 'stylesheet') {
        headers['content-type'] = ['text/css'];
      }

      callback({ responseHeaders: headers });
    });
    console.log('Discord header patches ready.');
  } catch (error) {
    console.error('Error setting up Discord header patches:', error);
  }
}

let rpcChild: Electron.UtilityProcess | null = null;
let processList: any[] = [];

function startRPC(window: BrowserWindow) {
    if (!config.arRPC) return;
    stopRPC();

    rpcChild = utilityProcess.fork(path.join(__dirname, "rpc.js"), undefined, {
        env: { detectables: JSON.stringify(getDetectables()) },
    });

    rpcChild.on("spawn", () => {
        console.log("[arRPC] process started");
    });

    rpcChild.on("message", (message) => {
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
        console.log("[arRPC] process exited");
        rpcChild = null;
        if (!isQuitting && config.arRPC && code !== 0 && mainWindow) {
          setTimeout(() => {
            if (mainWindow && !mainWindow.isDestroyed()) startRPC(mainWindow);
          }, 3000);
        }
    });
}

function stopRPC() {
    if (rpcChild) {
        rpcChild.kill();
        rpcChild = null;
    }
}

async function shutdownForRestart() {
  if (restartInProgress) return;
  restartInProgress = true;
  isQuitting = true;
  appendLog('info', 'Restart requested.');

  stopRPC();
  tray?.destroy();
  tray = null;

  try {
    await session.fromPartition(discordPartition).flushStorageData();
  } catch (error) {
    appendLog('warn', 'Could not flush Discord storage before restart.', error);
  }

  updateRecoveryState(true);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.removeAllListeners('close');
    mainWindow.destroy();
    mainWindow = null;
  }

  const relaunchArgs = process.argv
    .slice(1)
    .filter(arg => arg !== '--safe-mode' && arg !== '--restart-smoke-test');
  if (restartSmokeTestMode) relaunchArgs.push('--smoke-test');
  app.relaunch({ args: relaunchArgs });
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
  appliedFrameRate = null;
  appliedBackgroundThrottling = null;
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

  mainWindow.loadURL('https://discord.com/app');

  startRPC(mainWindow);
  createTray();

  mainWindow.once('ready-to-show', () => {
    if (!smokeTestMode) mainWindow?.show();
  });

  if (restoredState.maximized) mainWindow.maximize();

  mainWindow.on('show', updateWindowPerformance);
  mainWindow.on('hide', updateWindowPerformance);
  mainWindow.on('minimize', updateWindowPerformance);
  mainWindow.on('restore', updateWindowPerformance);
  mainWindow.on('move', queueWindowStateSave);
  mainWindow.on('resize', queueWindowStateSave);
  mainWindow.on('maximize', queueWindowStateSave);
  mainWindow.on('unmaximize', queueWindowStateSave);

  mainWindow.webContents.on('did-navigate', (event, url) => {
    console.log('Navigated to:', url);
  });

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    appendLog('error', `Discord failed to load (${code}: ${description}) at ${url}.`);
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting) return;
    rendererCrashCount += 1;
    appendLog('error', `Renderer exited: ${details.reason} (${details.exitCode}).`);

    if (rendererCrashCount >= 2) {
      sessionSafeMode = true;
      appendLog('warn', 'Repeated renderer failure; recovering without Vencord/Equicord for this session.');
    }

    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.reloadIgnoringCache();
      }
    }, 750);
  });

  mainWindow.on('unresponsive', async () => {
    appendLog('warn', 'Renderer became unresponsive.');
    if (!mainWindow || mainWindow.isDestroyed() || isQuitting) return;
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
      mainWindow?.webContents.reloadIgnoringCache();
    } else if (result.response === 2) {
      sessionSafeMode = true;
      app.relaunch({ args: [...process.argv.slice(1).filter(arg => arg !== '--safe-mode'), '--safe-mode'] });
      isQuitting = true;
      stopRPC();
      updateRecoveryState(true);
      app.exit(0);
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
    mainWindow = null;
  });

  updateWindowPerformance();
}

ipcMain.handle('kawaicord:getVersion', () => app.getVersion());
ipcMain.handle('kawaicord:reload', () => mainWindow?.reload());
ipcMain.handle('kawaicord:restart', () => {
  void shutdownForRestart();
  return true;
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

ipcMain.handle('kawaicord:getShelterBundle', () => {
  const userDataJsPath = path.join(app.getPath('userData'), 'shelter.js');
  const bundledJsPath = path.join(__dirname, '..', 'shelter', 'shelter.js');

  return {
    enabled: true,
    js: readFirstExisting([userDataJsPath, bundledJsPath])
  };
});

function getModBundle(mod: 'vencord' | 'equicord', enabled: boolean) {
  const userDataJsPath = path.join(app.getPath('userData'), `${mod}.js`);
  const userDataCssPath = path.join(app.getPath('userData'), `${mod}.css`);
  const bundledJsPath = path.join(__dirname, '..', mod, `${mod}.js`);
  const bundledCssPath = path.join(__dirname, '..', mod, `${mod}.css`);

  return {
    enabled: enabled && !sessionSafeMode,
    mod,
    js: readFirstExisting([userDataJsPath, bundledJsPath]),
    css: readFirstExisting([userDataCssPath, bundledCssPath])
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
  error?: string | null;
}) => {
  if (status.error) {
    appendLog('error', `Renderer injection failed: ${status.error}`);
  } else {
    const restartDetail = status.mod
      ? ` (${status.restartHooks ?? 0} restart calls routed)`
      : '';
    appendLog('info', `Renderer injection ready: Shelter + ${status.mod ?? 'recovery mode'}${restartDetail}.`);
    if (status.mod && !status.restartHooks) {
      appendLog('warn', `${status.mod} loaded without any restart-call hooks.`);
    }
  }

  if (smokeTestMode) {
    setTimeout(() => {
      isQuitting = true;
      app.quit();
    }, 500);
  } else if (restartSmokeTestMode) {
    setTimeout(() => void shutdownForRestart(), 500);
  }
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
    'trayIconAuto' | 'startAtLogin' | 'minimizeToTray' | 'autoUpdateMods'
  >> = [
    'performanceMode',
    'backgroundThrottling',
    'arRPC',
    'trayEnabled',
    'trayIconAuto',
    'startAtLogin',
    'minimizeToTray',
    'autoUpdateMods'
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
ipcMain.handle('window:isMaximized', () => mainWindow?.isMaximized());
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


app.commandLine.appendSwitch('disable-gpu-process-crash-limit');

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
    await refreshModBundles();
    await setupVencordInjection();
    createWindow();

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
