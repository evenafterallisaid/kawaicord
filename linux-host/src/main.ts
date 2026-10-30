import { app, BrowserWindow, ipcMain, session, shell, Tray, Menu, Notification, dialog, desktopCapturer, type Session, type IpcMainInvokeEvent } from 'electron';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { CoreBridge } from './core-bridge';
import { trusted, embedded, external, instanceId, commands } from './policy';
import type { Config } from '../../native-ui/types';

const args = process.argv;
const flag = (name: string) => args.includes(name);
const option = (name: string) => args[args.indexOf(name)+1];
const smoke = flag('--smoke-test');
const profile = resolve(flag('--profile') ? option('--profile') : join(process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share'), 'com.kawaicord.native'));
const resources = app.isPackaged ? process.resourcesPath : resolve(__dirname, '..', '..');
const icon = app.isPackaged ? join(resources, 'icon.png') : join(resources, 'src-tauri', 'icons', '128x128.png');
const recoveryFile = app.isPackaged ? join(resources, 'recovery', 'index.html') : join(resources, 'web-dist', 'index.html');
app.setPath('userData', join(profile, 'chromium'));
app.setName('Kawaicord');
let core: CoreBridge;
let config: Config;
let main: ClientWindow;
let tray: Tray | undefined;
let quitting = false;
let runtime: any;
let safeMode = false;
let sequence = 0;
const windows = new Map<number, ClientWindow>();
const scriptCache = new Map<string, string>();
const notifications = new Map<string, Notification>();
const temporarySlots = new Set<number>();
const grants: Record<string, boolean> = readJson(join(profile, 'media-permissions.json'), {});
const savedSessions: Record<string, boolean> = readJson(join(profile, 'chromium-sessions.json'), {});
interface ClientWindow { window: BrowserWindow; initialization: string; id?: string; name: string; domain: string; saveSession: boolean; ready: boolean; user: unknown; recovery?: boolean; slot?: number; diagnosed?: boolean; crashes: number; closed: Promise<void> }
function readJson<T>(path: string, fallback: T): T { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; } }
function saveJson(path: string, data: unknown) { mkdirSync(profile, { recursive: true }); const temporary=path+`.tmp-${process.pid}`; writeFileSync(temporary, JSON.stringify(data), { mode: 0o600 }); renameSync(temporary, path); }
function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
function alive(record?: ClientWindow) { return record && !record.window.isDestroyed(); }
function evaluate(record: ClientWindow, code: string) { return record.window.webContents.executeJavaScript(code); }
function background(record: ClientWindow, hidden: boolean) { if (!record.recovery && alive(record)) void evaluate(record, `window.__kawaicordSetBackground?.(${hidden})`).catch(() => {}); }
function chrome(record: ClientWindow) { return { maximized: record.window.isMaximized(), focused: record.window.isFocused() }; }
function show(record = main) { if (!alive(record)) return; record.window.show(); record.window.restore(); record.window.focus(); background(record, false); }
async function openExternal(address: string) { if (external(address)) await shell.openExternal(address); }
function authenticated(event: IpcMainInvokeEvent) {
  const record = windows.get(event.sender.id);
  if (!record || event.senderFrame !== event.sender.mainFrame || (!trusted(event.senderFrame.url) && !(record.recovery && event.senderFrame.url.split('#')[0] === pathToFileURL(recoveryFile).href))) throw new Error('Untrusted renderer');
  return record;
}
const configured = new WeakSet<Session>();
function configureSession(ses: Session) {
  if (configured.has(ses)) return; configured.add(ses);
  ses.setUserAgent(ses.getUserAgent().replace(/ (?:Electron|Kawaicord|kawaicord-linux)\/[^ ]+/g, ''));
  ses.setPermissionCheckHandler((_contents, permission, origin, details) => {
    if (!trusted(origin)) return false;
    if (permission === 'notifications') return config.notifications;
    if (permission === 'media') return grants[`${new URL(origin).origin}:${details.mediaType ?? 'unknown'}`] === true;
    return permission === 'fullscreen' || permission === 'clipboard-sanitized-write';
  });
  ses.setPermissionRequestHandler(async (contents, permission, callback, details) => {
    const origin = details.requestingUrl || contents?.getURL() || '';
    if (!trusted(origin)) return callback(false);
    if (permission === 'notifications') return callback(config.notifications);
    if (permission === 'fullscreen' || permission === 'clipboard-sanitized-write') return callback(true);
    if (permission !== 'media') return callback(false);
    const types = 'mediaTypes' in details ? details.mediaTypes?.filter(value => value === 'audio' || value === 'video') ?? [] : [];
    if (!types.length) return callback(false);
    const normalized = new URL(origin).origin;
    if (types.every(type => grants[`${normalized}:${type}`])) return callback(true);
    const parent = contents ? BrowserWindow.fromWebContents(contents) : null;
    const devices = types.map(type => type === 'audio' ? 'microphone' : 'camera').join(' and ');
    const options = { type: 'question' as const, title: 'Discord device access', message: `Allow Discord to use your ${devices}?`, buttons: ['Allow', 'Deny'], defaultId: 1, cancelId: 1 };
    try {
      const choice = parent ? await dialog.showMessageBox(parent, options) : await dialog.showMessageBox(options);
      if (choice.response === 0) { for (const type of types) grants[`${normalized}:${type}`] = true; saveJson(join(profile, 'media-permissions.json'), grants); callback(true); }
      else callback(false);
    } catch { callback(false); }
  });
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    if (!trusted(request.securityOrigin)) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false });
      const choices = sources.slice(0, 32);
      const result = await dialog.showMessageBox({ type: 'question', title: 'Share a screen or window', message: 'Choose what Discord can share.', buttons: ['Cancel', ...choices.map(source => source.name)], defaultId: 0, cancelId: 0 });
      if (result.response > 0 && choices[result.response-1]) callback({ video: choices[result.response-1] }); else callback({});
    } catch { callback({}); }
  }, { useSystemPicker: true });
}
async function initialization(id?: string, performanceMode = config.performanceMode, recover = safeMode) {
  const key = `${performanceMode}:${recover}`;
  if (!scriptCache.has(key)) scriptCache.set(key, await core.request('initialize', { id, performanceMode, safeMode: recover }));
  return scriptCache.get(key)!;
}
async function createWindow(id?: string, name = 'Kawaicord', persistent = true, domain = 'discord.com', performanceMode = config.performanceMode): Promise<ClientWindow> {
  if (!['discord.com', 'ptb.discord.com', 'canary.discord.com'].includes(domain)) throw new Error('Unsupported Discord domain');
  if (id) instanceId(id);
  const existing = [...windows.values()].find(record => !record.recovery && record.id === id);
  if (existing) { show(existing); return existing; }
  if (windows.size >= 9) throw new Error('Close an instance before opening another');
  if (id && persistent && !savedSessions[id] && Object.keys(savedSessions).length >= 32) throw new Error('The saved session limit has been reached');
  let slot: number | undefined;
  if (!persistent) { slot = Array.from({ length: 9 }, (_, index) => index).find(index => !temporarySlots.has(index)); if (slot === undefined) throw new Error('No temporary session slot is available'); temporarySlots.add(slot); }
  const partition = persistent ? `persist:kawaicord-${id ? hash(id) : 'main'}` : `temporary-${slot}`;
  const ses = session.fromPartition(partition);
  if (!persistent) { await ses.clearStorageData(); await ses.clearCache(); }
  configureSession(ses);
  const source = await initialization(id, performanceMode);
  const saved = !id ? readJson(join(profile, 'window.json'), { width: 1180, height: 820, maximized: false }) : { width: 1100, height: 800, maximized: false };
  const win = new BrowserWindow({ title: name.slice(0, 80), width: Math.min(10000, Math.max(800, saved.width || 1180)), height: Math.min(8000, Math.max(600, saved.height || 820)), minWidth: 800, minHeight: 600, frame: false, show: !smoke, icon, backgroundColor: '#111214', autoHideMenuBar: true, webPreferences: { preload: join(__dirname, 'preload.cjs'), session: ses, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false, autoplayPolicy: 'no-user-gesture-required' } });
  let closed!: () => void;
  const record: ClientWindow = { window: win, initialization: source, id, name, domain, saveSession: persistent, slot, ready: false, user: null, crashes: 0, closed: new Promise(resolve => { closed = resolve; }) };
  windows.set(win.webContents.id, record); win.removeMenu();
  if (id && persistent) { savedSessions[id] = true; saveJson(join(profile, 'chromium-sessions.json'), savedSessions); }
  win.webContents.on('before-input-event', (event, input) => { if (input.type === 'keyDown' && input.control && input.key.toLowerCase() === 'q') { event.preventDefault(); void quit(); } });
  win.webContents.setWindowOpenHandler(({ url }) => { void openExternal(url).catch(() => {}); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (event, url) => { if (!trusted(url)) { event.preventDefault(); void openExternal(url).catch(() => {}); } });
  win.webContents.on('will-frame-navigate', event => { if (!embedded(event.url)) event.preventDefault(); });
  win.webContents.on('render-process-gone', async () => {
    record.ready = false; record.crashes++;
    if (quitting || record.crashes > 2) { if (!smoke) await recovery(); return; }
    if (record.crashes === 2) record.initialization = await initialization(id, performanceMode, true);
    win.reload();
  });
  let previous = '';
  const updateChrome = () => { const state = JSON.stringify(chrome(record)); if (state !== previous) { previous = state; void evaluate(record, `window.__kawaicordWindowState?.(${state})`).catch(() => {}); } };
  win.on('maximize', updateChrome); win.on('unmaximize', updateChrome); win.on('focus', updateChrome); win.on('blur', updateChrome);
  win.on('minimize', () => background(record, true)); win.on('hide', () => background(record, true));
  win.on('restore', () => background(record, false)); win.on('show', () => background(record, false));
  win.on('close', event => {
    if (!id && !quitting && config.minimizeToTray) { event.preventDefault(); win.hide(); return; }
    if (!id && !quitting) { event.preventDefault(); void quit(); }
  });
  const webId = win.webContents.id;
  win.on('closed', () => {
    windows.delete(webId);
    void (async () => { if (!persistent) { await ses.clearStorageData().catch(() => {}); await ses.clearCache().catch(() => {}); if (slot !== undefined) temporarySlots.delete(slot); } closed(); })();
  });
  if (!id) main = record;
  if (saved.maximized) win.maximize();
  void win.loadURL(`https://${domain}/app`).catch(() => { if (!smoke && !quitting) void recovery(); });
  return record;
}
async function closeInstances() { const instances = [...windows.values()].filter(record => record.id); for (const record of instances) record.window.destroy(); await Promise.all(instances.map(record => record.closed)); }
async function clearSession(id: string) {
  instanceId(id); if ([...windows.values()].some(record => record.id === id)) throw new Error('Close the instance before clearing its session');
  const ses = session.fromPartition(`persist:kawaicord-${hash(id)}`); await ses.clearStorageData(); await ses.clearCache(); delete savedSessions[id]; saveJson(join(profile, 'chromium-sessions.json'), savedSessions);
}
function setTray() {
  if (!config.trayEnabled) { tray?.destroy(); tray = undefined; return; }
  if (!tray) { tray = new Tray(icon); tray.on('click', () => show()); }
  tray.setToolTip('Kawaicord');
  tray.setContextMenu(Menu.buildFromTemplate([{ label: 'Show Discord', click: () => show() }, { label: 'Settings', click: () => void settings() }, { type: 'separator' }, { label: 'Quit Kawaicord', click: () => void quit() }]));
}
function loginStartup() {
  const path = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'autostart', 'kawaicord.desktop');
  mkdirSync(resolve(path, '..'), { recursive: true });
  const executable = process.env.APPIMAGE ?? process.execPath;
  const escaped = executable.replace(/[\\"`$]/g, character => '\\'+character);
  const entry = `[Desktop Entry]\nType=Application\nName=Kawaicord\nExec="${escaped}"\nTerminal=false\nHidden=${!config.startAtLogin}\nX-GNOME-Autostart-enabled=${config.startAtLogin}\n`;
  writeFileSync(path, entry, { mode: 0o600 });
}
async function settings() { show(); if (main.ready) await evaluate(main, 'window.kawaicord.openSettings()'); else await recovery(); }
async function recovery() {
  const existing = [...windows.values()].find(record => record.recovery); if (existing) { show(existing); return; }
  const win = new BrowserWindow({ title: 'Kawaicord Settings', width: 720, height: 850, minWidth: 570, minHeight: 560, icon, webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  let closed!: () => void;
  const record: ClientWindow = { window: win, initialization: '', name: 'Recovery', domain: '', saveSession: false, recovery: true, ready: false, user: null, crashes: 0, closed: new Promise(resolve => { closed = resolve; }) };
  windows.set(win.webContents.id, record); const webId = win.webContents.id;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => { if (event.url !== pathToFileURL(recoveryFile).href) event.preventDefault(); });
  win.on('closed', () => { windows.delete(webId); closed(); });
  await win.loadFile(recoveryFile);
}
async function quit(code?: number) {
  if (quitting) return; quitting = true;
  if (alive(main) && !main.window.isMaximized() && !main.window.isMinimized()) { const bounds = main.window.getBounds(); saveJson(join(profile, 'window.json'), { width: bounds.width, height: bounds.height, maximized: false }); }
  else if (alive(main)) { const bounds = main.window.getNormalBounds(); saveJson(join(profile, 'window.json'), { width: bounds.width, height: bounds.height, maximized: main.window.isMaximized() }); }
  await core?.close(); tray?.destroy();
  if (code === undefined) app.quit(); else app.exit(code);
}
async function restart(recover = false) { if (recover) saveJson(join(profile, 'safe-mode.json'), true); app.relaunch({ execPath: process.env.APPIMAGE ?? process.execPath }); await quit(); }

ipcMain.on('kawaicord:initialization', event => { try { const record = authenticated(event); event.returnValue = record.initialization; } catch { event.returnValue = ''; } });
ipcMain.on('kawaicord:initialization-failed', event => { try { authenticated(event); if (!smoke) void recovery(); } catch {} });
ipcMain.handle('kawaicord:invoke', async (event, command: string, data: Record<string, any> = {}) => {
  const record = authenticated(event);
  if (!commands.has(command) || !data || typeof data !== 'object') throw new Error('Unsupported client action');
  if (record.recovery && !['get_settings', 'save_config', 'show_discord', 'restart_app', 'restart_recovery', 'refresh_mods', 'check_update', 'install_update', 'open_releases'].includes(command)) throw new Error('Unavailable recovery action');
  switch (command) {
    case 'window_action': { const state = chrome(record); switch (data.action) { case 'state': break; case 'minimize': record.window.minimize(); break; case 'maximize': if (state.maximized) record.window.unmaximize(); else record.window.maximize(); break; case 'close': record.window.close(); return state; case 'drag': break; default: throw new Error('Unsupported window action'); } return chrome(record); }
    case 'notification_permission': return Notification.isSupported() ? 'granted' : 'denied';
    case 'notify': {
      if (!config.notifications || !Number.isSafeInteger(data.id) || data.id < 0 || data.id > 2_000_000_000 || typeof data.title !== 'string' || typeof data.body !== 'string') throw new Error('Notifications disabled or invalid');
      while (notifications.size >= 64) { const id = notifications.keys().next().value!; notifications.get(id)?.close(); notifications.delete(id); }
      const notification = new Notification({ title: data.title.slice(0, 160), body: data.body.slice(0, 1000), icon }); const key = `${event.sender.id}:${data.id}`; notifications.get(key)?.close(); notifications.set(key, notification);
      notification.on('click', () => { show(record); void evaluate(record, `window.__kawaicordNotificationClick?.(${data.id})`).catch(() => {}); notifications.delete(key); });
      notification.on('close', () => notifications.delete(key)); notification.show(); return;
    }
    case 'close_notification': { const key = `${event.sender.id}:${data.id}`; notifications.get(key)?.close(); notifications.delete(key); return; }
    case 'set_unread': { const count = Number.isFinite(data.count) ? Math.min(9999, Math.max(0, data.count)) : 0; app.setBadgeCount(count); tray?.setToolTip(count ? `Kawaicord (${count})` : 'Kawaicord'); return; }
    case 'report_runtime': {
      record.ready = data.status?.ready === true;
      if (!record.id) { runtime = data.status; await core.request(command, data); if (smoke && !record.diagnosed) { record.diagnosed = true; void diagnose(record, data.status).catch(error => { saveJson(join(profile, 'integration.json'), { ok: false, error: String(error) }); void quit(1); }); } }
      return;
    }
    case 'get_settings': return core.dead ? { config, runtime: { ...runtime, error: 'The Rust service stopped. Restart Kawaicord when ready.' }, updater: { available: false, message: 'The Rust service is unavailable.' } } : core.request(command);
    case 'save_config': {
      const oldStartup = config.startAtLogin; config = await core.request(command, data); scriptCache.clear();
      setTray(); if (oldStartup !== config.startAtLogin) loginStartup();
      for (const window of windows.values()) if (!window.recovery) void evaluate(window, `window.__kawaicordUpdateConfig?.(${JSON.stringify(config)})`).catch(() => {});
      return config;
    }
    case 'cloud_request': return core.request(command, { ...data, origin: new URL(event.senderFrame!.url).origin });
    case 'restart_app': return restart();
    case 'restart_recovery': return restart(true);
    case 'reload_discord': record.initialization = await initialization(record.id); record.window.reload(); return;
    case 'open_releases': return shell.openExternal('https://github.com/evenafterallisaid/kawaicord/releases');
    case 'open_settings': if (data.fallback) return recovery(); return settings();
    case 'show_discord': show(); if (record.recovery) record.window.close(); return;
    case 'list_instances': return [...windows.values()].filter(window => window.id).map(window => ({ id: window.id, name: window.name, domain: window.domain, mode: 'detached', saveSession: window.saveSession, ready: window.ready, user: window.user }));
    case 'open_instance': { if (data.blockExternalTokenAccess) throw new Error('External token blocking is not available in this host'); await createWindow(instanceId(data.id), typeof data.name === 'string' ? data.name : 'Discord instance', data.saveSession === true, data.domain, data.performanceMode === true); return; }
    case 'close_instance': { const target = [...windows.values()].find(window => window.id === instanceId(data.id)); if (target) { target.window.destroy(); await target.closed; } return; }
    case 'close_all_instances': await closeInstances(); return;
    case 'clear_instance_session': await clearSession(instanceId(data.id)); return;
    case 'report_instance_user': { if (record.id && data.user && typeof data.user === 'object') record.user = { id: String(data.user.id ?? '').slice(0, 32), username: String(data.user.username ?? '').slice(0, 80), globalName: typeof data.user.globalName === 'string' ? data.user.globalName.slice(0, 80) : null, avatarUrl: typeof data.user.avatarUrl === 'string' && data.user.avatarUrl.startsWith('https://cdn.discordapp.com/') ? data.user.avatarUrl.slice(0, 500) : '' }; return; }
    case 'refresh_mods': await core.request(command); scriptCache.clear(); return;
    case 'install_update': { const result = await core.request(command); if (result?.restart) return restart(); return; }
    default: return core.request(command, data);
  }
});
async function ready(record: ClientWindow) { for (let attempt=0;attempt<90;attempt++) { if (record.ready) return; await new Promise(resolve => setTimeout(resolve, 1000)); } throw new Error('Discord did not initialize in its instance'); }
async function diagnose(record: ClientWindow, status: any) {
  if (!status.ready) return quit(1);
  if (flag('--media-test')) {
    const report = await evaluate(record, flag('--media-preflight') ? 'window.__kawaicordMediaCapabilities()' : 'window.__kawaicordTestAudio()');
    saveJson(join(profile, 'media.json'), report); console.log(JSON.stringify(report)); await quit(report.ok ? 0 : 1); return;
  }
  if (flag('--background-test')) {
    const start=Date.now();
    await evaluate(record,'window.__kawaicordBackgroundProbe=window.__kawaicordTestAudio(370000); true');
    record.window.hide(); status.backgroundAudio=await evaluate(record,'window.__kawaicordBackgroundProbe');
    status.backgroundElapsed=Date.now()-start; status.backgroundHidden=await evaluate(record,'document.hidden'); status.ready=await evaluate(record,'!!window.shelter&&Object.keys(window.Vencord?.Webpack?.cache||{}).length>100');
    saveJson(join(profile,'runtime.json'),status); await quit(status.ready&&status.backgroundHidden&&status.backgroundAudio.ok?0:1); return;
  }
  if (flag('--integration-test')) {
    record.window.show();
    const idA=`smoke-a-${process.pid}`,idB=`smoke-b-${process.pid}`;
    const a=await createWindow(idA,'isolated a',true),b=await createWindow(idB,'isolated b',true); await Promise.all([ready(a),ready(b)]);
    const mark="(()=>{document.cookie='__kawaicord_isolation_cookie=alpha;Path=/;Secure;SameSite=Lax';const frame=document.createElement('iframe');document.body.append(frame);frame.contentWindow.localStorage.setItem('__kawaicord_isolation_probe','alpha');frame.remove();return true})()";
    const clean="(()=>{const frame=document.createElement('iframe');document.body.append(frame);const ok=frame.contentWindow.localStorage.getItem('__kawaicord_isolation_probe')===null;frame.remove();return ok&&!document.cookie.includes('__kawaicord_isolation_cookie=')})()";
    await evaluate(a,mark); if (!await evaluate(b,clean)) throw new Error('Saved instances share storage');
    await evaluate(record,"(()=>{shelter.solid.createRoot(()=>document.body.append(window.__kawaicordSettingsPage()));return true})()");
    for (let attempt=0;attempt<30;attempt++) { if(await evaluate(record,"document.querySelectorAll('#kawaicord-settings input[type=checkbox]').length>=9")) break; await new Promise(resolve=>setTimeout(resolve,100)); }
    if (!await evaluate(record,"document.querySelectorAll('#kawaicord-settings input[type=checkbox]').length>=9")) throw new Error('Discord settings did not render');
    if (!await evaluate(record,"Array.from(document.querySelectorAll('#kawaicord-settings button')).filter(b=>b.getClientRects().length).every(b=>b.scrollWidth<=b.clientWidth+1)")) throw new Error('Settings button labels overflow');
    const cloud=await evaluate(record,"fetch('https://cloud.equicord.org/v1/oauth/settings').then(r=>r.json()).then(v=>!!v.clientId&&!!v.redirectUri)"); if(!cloud) throw new Error('Cloud configuration failed');
    if(!await evaluate(record,"typeof window.VencordNative?.pluginHelpers?.MultiInstance?.openInstance==='function'")) throw new Error('Native instance helper is missing');
    const controls=await evaluate(record,"document.getElementById('kawaicord-window-controls')?.shadowRoot.querySelectorAll('button').length===3"); if(!controls) throw new Error('Custom window controls are missing');
    await evaluate(record,"document.getElementById('kawaicord-window-controls').shadowRoot.querySelectorAll('button')[1].click()"); await new Promise(resolve=>setTimeout(resolve,200)); if(!record.window.isMaximized()) throw new Error('Maximize did not work');
    await evaluate(record,"document.getElementById('kawaicord-window-controls').shadowRoot.querySelectorAll('button')[1].click()");
    await closeInstances(); await clearSession(idA); await clearSession(idB);
    const reopened=await createWindow(idA,'cleared session',true); await ready(reopened); if(!await evaluate(reopened,clean)) throw new Error('Cleared session came back'); await closeInstances();
    const temporaryA=await createWindow(idA,'temporary a',false),temporaryB=await createWindow(idB,'temporary b',false); await Promise.all([ready(temporaryA),ready(temporaryB)]); await evaluate(temporaryA,mark); if(!await evaluate(temporaryB,clean)) throw new Error('Temporary sessions share storage');
    await closeInstances(); const fresh=await createWindow(idA,'fresh temporary',false); await ready(fresh); if(!await evaluate(fresh,clean)) throw new Error('Temporary session was restored'); await closeInstances();
    if(process.env.KAWAICORD_FRAME_CAPTURE) writeFileSync(process.env.KAWAICORD_FRAME_CAPTURE,(await record.window.capturePage({x:0,y:0,width:record.window.getContentBounds().width,height:64})).toPNG());
    const report={ok:true,separateSessionStorage:true,clearedSessionStayedCleared:true,temporarySessionsIsolated:true,temporarySessionNotRestored:true,discordSettingsRendered:true,buttonLabelsFit:true,oauthConfigurationLoaded:true,nativeInstanceHelper:true,customWindowControls:true};saveJson(join(profile,'integration.json'),report);console.log(JSON.stringify(report));
  }
  await quit(0);
}
async function start() {
  await app.whenReady();
  const binary=app.isPackaged?join(resources,'kawaicord-core'):join(resources,'src-tauri','target','release','kawaicord-core');
  core=new CoreBridge(binary,['--profile',profile,...(smoke?['--smoke-test']:[]),...(flag('--safe-mode')?['--safe-mode']:[])]);
  const initial=await new Promise<any>((resolve,reject)=>{const timeout=setTimeout(()=>reject(new Error('Rust service startup timed out')),60000);core.once('ready',value=>{clearTimeout(timeout);resolve(value);});core.once('stopped',value=>{clearTimeout(timeout);reject(new Error(value));});});
  config=initial.config; safeMode=initial.safeMode;
  core.on('activity',event=>{if(alive(main))void evaluate(main,`window.__kawaicordActivity?.(${JSON.stringify(event.data)})`).catch(()=>{});});
  await createWindow(); if(!smoke)setTray();
  app.on('activate',()=>show());
  app.on('before-quit',event=>{if(!quitting){event.preventDefault();void quit();}});
  app.on('window-all-closed',()=>{});
  app.on('web-contents-created',(_event,contents)=>{contents.on('will-attach-webview',event=>event.preventDefault());});
  if(!smoke){const check=()=>{if(config.autoUpdateApp)void core.request('check_update').catch(()=>{});};setTimeout(()=>{check();setInterval(check,6*3600_000).unref();},60000).unref();}
}
app.on('second-instance',()=>show());
if(!smoke&&!app.requestSingleInstanceLock())app.quit();else void start().catch(error=>{console.error(String(error));if(!smoke)dialog.showErrorBox('Kawaicord could not start','The native service could not be initialized. Try reinstalling the current release.');app.exit(1);});
