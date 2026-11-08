import { testAudioTransport } from './media';
import { spotifyDiagnostics } from './spotify';
import { refreshSpotifyLocal } from './spotify-local';
import type { ClientMod, Config, RuntimeStatus } from './types';
export type Invoke = <T>(command: string, args?: Record<string, unknown>) => Promise<T>;
interface SettingsData { config: Config; runtime: RuntimeStatus; updater: { available: boolean; message: string } }
const options: Array<[keyof Config, string, string]> = [
  ['performanceMode', 'Background performance mode', 'Pause decorative animations and image painting while hidden. Calls and messages stay live.'],
  ['staticNameplates', 'Use static nameplates', 'Preserve colors and transparency on webviews that cannot render transparent nameplate videos.'],
  ['richPresence', 'Local Rich Presence', 'Show activity from games and applications that connect through Discord RPC.'],
  ['detectGames', 'Detect running games', 'Check running applications every 30 seconds. Disabled by default to reduce background work.'],
  ['notifications', 'Desktop notifications', 'Show Discord notifications through your operating system.'],
  ['trayEnabled', 'Show tray icon', 'Keep Kawaicord available in the system tray or macOS menu bar.'],
  ['minimizeToTray', 'Keep running when closed', 'Hide the window when closed. Use Quit Kawaicord to exit.'],
  ['startAtLogin', 'Start at login', 'Open Kawaicord when you sign in to your computer.'],
  ['autoUpdateMods', 'Update client mods automatically', 'Download official browser builds for the next restart.'],
  ['previewUpdates', 'Receive preview updates', 'Include experimental releases when checking for updates. Off by default.'],
  ['autoUpdateApp', 'Check for app updates', 'Check for new releases. Install updates when you are ready.']
];

export function openDiscordSettings(): boolean {
  const router = (window.Vencord?.Webpack as any)?.Common?.SettingsRouter;
  if (typeof router?.openUserSettings !== 'function') return false;
  router.openUserSettings('shelter_kawaicord_panel');
  return true;
}

export function createDiscordSettings(invoke: Invoke): HTMLElement {
  const root = document.createElement('div');
  root.id = 'kawaicord-settings';
  root.style.cssText = 'color:var(--text-normal);font-family:var(--font-primary);width:100%';
  root.textContent = 'Loading Kawaicord settings…';
  const { solid, solidWeb, ui } = window.shelter as any;
  const owner = solid.getOwner();
  let disposed = false;
  solid.onCleanup(() => { disposed = true; });
  void invoke<SettingsData>('get_settings').then(data => {
    if (disposed) return;
    solid.runWithOwner(owner, () => {
      const [config, setConfig] = solid.createSignal(data.config) as [() => Config, (value: Config) => void];
      const [selected, setSelected] = solid.createSignal(data.config.activeMod) as [() => ClientMod, (value: ClientMod) => void];
      const [busy, setBusy] = solid.createSignal(false);
      const [notice, setNotice] = solid.createSignal('');
      const [update, setUpdate] = solid.createSignal(data.updater.message);
      const [available, setAvailable] = solid.createSignal(data.updater.available);
      const [spotify, setSpotify] = solid.createSignal('');
      const [voice, setVoice] = solid.createSignal('');
      const component = (name: string, props: Record<string, unknown>) => solid.createComponent(ui[name], props);
      const append = (parent: HTMLElement, ...children: any[]) => { const marker = document.createComment(''); parent.append(marker); solidWeb.insert(parent, children, marker); };
      const heading = (text: string) => component('Header', { tag: ui.HeaderTags.HeadingLG, children: text });
      const text = (value: string) => component('Text', { tag: ui.TextTags.textSM, style: { color: 'var(--text-muted)', 'margin-bottom': '20px' }, children: value });
      const divider = () => component('Divider', { mt: '24px', mb: '24px' });
      const buttons = (...children: any[]) => { const row = document.createElement('div'); row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:12px 0 16px'; append(row, ...children); return row; };
      function section(title: string) {
        const details = document.createElement('details');
        details.style.cssText = 'border-top:1px solid var(--border-subtle);padding:12px 0';
        const summary = document.createElement('summary');
        summary.style.cssText = 'cursor:pointer;font-weight:600;color:var(--header-primary);padding:4px 0';
        summary.textContent = title;
        const content = document.createElement('div');
        content.style.paddingTop = '12px';
        details.append(summary, content);
        root.append(details);
        return content;
      }
      const status = (value: () => string) => component('Text', {
        role: 'status', tag: ui.TextTags.textSM, style: { color: 'var(--text-muted)' }, get children() { return value(); }
      });
      async function act(fn: () => Promise<void>) {
        if (busy()) return;
        setBusy(true); setNotice('');
        try { await fn(); } catch (error) { setNotice(String(error)); } finally { setBusy(false); }
      }
      const button = (title: string, action: () => Promise<void>, primary = false, inactive = () => false) => component('Button', {
        children: title, color: primary ? ui.ButtonColors.PRIMARY : ui.ButtonColors.SECONDARY,
        size: ui.ButtonSizes.MEDIUM, grow: true,
        get disabled() { return busy() || inactive(); }, onClick: () => void act(action)
      });
      root.replaceChildren();
      append(root,
        component('Header', { tag: ui.HeaderTags.HeadingXL, children: 'Kawaicord' }),
        text(`Version ${data.runtime.version}`), status(notice), heading('Client mod'),
        component('Select', {
          'aria-label': 'Client mod', get value() { return selected(); }, get disabled() { return busy(); },
          onChange: (value: ClientMod) => setSelected(value),
          get children() { return (['vencord', 'equicord', 'illegalcord'] as const).map(value => component('SelectOption', { value, children: { vencord: 'Vencord', equicord: 'Equicord', illegalcord: 'Illegalcord' }[value] })); }
        }),
        buttons(button('Save and restart', async () => {
          setConfig(await invoke<Config>('save_config', { config: { ...config(), activeMod: selected() } }));
          await invoke('restart_app');
        }, true, () => selected() === config().activeMod)),
        divider(), heading('Essentials')
      );
      function switches(parent: HTMLElement, keys: (keyof Config)[]) {
        for (const key of keys) {
          const option = options.find(([name]) => name === key);
          if (!option) continue;
          const [, title, note] = option;
          append(parent, component('SwitchItem', {
            children: title, note, get checked() { return config()[key] === true; }, get disabled() { return busy(); },
            onChange: (value: boolean) => void act(async () => setConfig(await invoke<Config>('save_config', { config: { ...config(), [key]: value } })))
          }));
        }
      }
      switches(root, ['notifications', 'minimizeToTray', 'performanceMode']);
      switches(section('Desktop and activity'), ['trayEnabled', 'startAtLogin', 'staticNameplates', 'richPresence', 'detectGames']);
      const spotifySection = section('Spotify');
      append(spotifySection, status(spotify), buttons(button('Check Spotify connection', async () => { await refreshSpotifyLocal(); setSpotify(spotifyDiagnostics().summary); })));
      append(spotifySection, component('SwitchItem', {
        children: 'Use Spotify companion', note: 'An alternative for Listen Along that requires Spicetify and Spotify Premium.',
        get checked() { return config().spotifyLocalPlayback; }, get disabled() { return busy(); },
        onChange: (value: boolean) => void act(async () => setConfig(await invoke<Config>('save_config', { config: { ...config(), spotifyLocalPlayback: value, spotifyNativePlayback: value ? false : config().spotifyNativePlayback } })))
      }), text('Setup backs up your Spicetify configuration. Reopen Spotify afterward.'),
      buttons(button('Install Spotify companion', async () => { const result = await invoke<{message:string}>('spotify_bridge', { request: { action: 'install' } }); setSpotify(result.message); })));
      if (data.runtime.platform === 'macos' || data.runtime.platform === 'linux') append(spotifySection, component('SwitchItem', {
        children: 'Use native Spotify control',
        note: data.runtime.platform === 'macos' ? 'Sync through Spotify’s macOS automation interface without Spicetify. macOS asks permission to control Spotify. Spotify Premium is still required for Listen Along.' : 'Sync through Spotify’s desktop MPRIS interface without Spicetify. Requires a running Spotify app with MPRIS support and Spotify Premium.',
        get checked() { return config().spotifyNativePlayback; }, get disabled() { return busy(); },
        onChange: (value: boolean) => void act(async () => setConfig(await invoke<Config>('save_config', { config: { ...config(), spotifyNativePlayback: value, spotifyLocalPlayback: value ? false : config().spotifyLocalPlayback } })))
      }));
      const install = document.createElement('span');
      append(install, button('Install update and restart', async () => { setUpdate('Downloading and verifying the update…'); try { await invoke('install_update'); } catch (error) { setUpdate(String(error)); throw error; } }, true));
      solid.createEffect(() => { install.style.display = available() ? '' : 'none'; });
      const updates = section('Updates');
      append(updates, status(update), buttons(button('Check for updates', async () => {
        setAvailable(false); setUpdate('Checking for updates…');
        try { const result = await invoke<{ available: boolean; message: string }>('check_update'); setUpdate(result.message); setAvailable(result.available); } catch (error) { setUpdate(String(error)); throw error; }
      }), install, button('Refresh mod bundles', async () => { await invoke('refresh_mods'); setUpdate('Client mods are ready. Restart Kawaicord to apply them.'); })));
      switches(updates, ['autoUpdateApp', 'autoUpdateMods', 'previewUpdates']);
      const recovery = section('Troubleshooting');
      if (data.runtime.error || data.runtime.safeMode) (recovery.parentElement as HTMLDetailsElement).open = true;
      append(recovery, status(voice), buttons(button('Test audio transport', async () => {
        const result = await testAudioTransport();
        setVoice(result.ok ? 'Local audio transport works.' : result.error ?? 'Audio test failed.');
      })), text(data.runtime.error ?? (data.runtime.safeMode ? 'Recovery mode is active.' : 'Recovery mode temporarily pauses your client mod.')),
      buttons(button(data.runtime.safeMode ? 'Restart normally' : 'Restart in recovery mode', async () => { await invoke(data.runtime.safeMode ? 'restart_app' : 'restart_recovery'); })));
    });
  }).catch(error => { if (!disposed) root.textContent = `Could not load Kawaicord settings: ${String(error)}`; });
  return root;
}
