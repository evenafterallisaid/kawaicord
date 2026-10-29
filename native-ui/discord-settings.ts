import { testAudioTransport } from './media';
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
      const component = (name: string, props: Record<string, unknown>) => solid.createComponent(ui[name], props);
      const append = (parent: HTMLElement, ...children: any[]) => { const marker = document.createComment(''); parent.append(marker); solidWeb.insert(parent, children, marker); };
      const heading = (text: string) => component('Header', { tag: ui.HeaderTags.HeadingLG, children: text });
      const text = (value: string) => component('Text', { tag: ui.TextTags.textSM, style: { color: 'var(--text-muted)', 'margin-bottom': '20px' }, children: value });
      const divider = () => component('Divider', { mt: '24px', mb: '24px' });
      const buttons = (...children: any[]) => { const row = document.createElement('div'); row.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin:16px 0 24px'; append(row, ...children); return row; };
      async function act(fn: () => Promise<void>) {
        if (busy()) return;
        setBusy(true); setNotice('');
        try { await fn(); } catch (error) { setNotice(String(error)); } finally { setBusy(false); }
      }
      const button = (title: string, action: () => Promise<void>, primary = false) => component('Button', {
        children: title, color: primary ? ui.ButtonColors.PRIMARY : ui.ButtonColors.SECONDARY,
        size: ui.ButtonSizes.MEDIUM, grow: true,
        get disabled() { return busy(); }, onClick: () => void act(action)
      });
      root.replaceChildren();
      append(root,
        component('Header', { tag: ui.HeaderTags.HeadingXL, children: 'Kawaicord' }),
        text(`Version ${data.runtime.version}`), heading('Client mod'),
        text('Shelter runs alongside your selected client mod. Restart to apply a change.'),
        component('Select', {
          'aria-label': 'Client mod', get value() { return selected(); }, get disabled() { return busy(); },
          onChange: (value: ClientMod) => setSelected(value),
          get children() { return (['vencord', 'equicord', 'illegalcord'] as const).map(value => component('SelectOption', { value, children: { vencord: 'Vencord', equicord: 'Equicord', illegalcord: 'Illegalcord' }[value] })); }
        }),
        buttons(button('Save and restart', async () => {
          setConfig(await invoke<Config>('save_config', { config: { ...config(), activeMod: selected() } }));
          await invoke('restart_app');
        }, true)),
        divider(), heading('Background and desktop')
      );
      for (const [key, title, note] of options) {
        if (key === 'notifications') append(root, divider(), heading('Desktop integration'));
        if (key === 'autoUpdateMods') append(root, divider(), heading('Update preferences'));
        append(root, component('SwitchItem', {
        children: title, note, get checked() { return config()[key] === true; }, get disabled() { return busy(); },
        onChange: (value: boolean) => void act(async () => setConfig(await invoke<Config>('save_config', { config: { ...config(), [key]: value } })))
      }));
      }
      append(root, divider(), heading('Voice diagnostics'), text('Test local audio transport without opening your microphone or sending audio to anyone.'), buttons(button('Test audio transport', async () => { const result = await testAudioTransport(); setNotice(result.ok ? 'Local audio transport works. If Discord rejects calls, check browser compatibility and microphone permissions.' : result.error ?? 'Audio test failed.'); })));
      const install = document.createElement('span');
      append(install, button('Install update and restart', async () => { setUpdate('Downloading and verifying the update…'); try { await invoke('install_update'); } catch (error) { setUpdate(String(error)); throw error; } }, true));
      solid.createEffect(() => { install.style.display = available() ? '' : 'none'; });
      append(root, divider(), heading('Updates'), component('Text', {
        tag: ui.TextTags.textSM, style: { color: 'var(--text-muted)' }, get children() { return update(); }
      }), buttons(button('Check for updates', async () => {
        setAvailable(false); setUpdate('Checking for updates…');
        try { const result = await invoke<{ available: boolean; message: string }>('check_update'); setUpdate(result.message); setAvailable(result.available); } catch (error) { setUpdate(String(error)); throw error; }
      }), install, button('Refresh mod bundles', async () => { await invoke('refresh_mods'); setNotice('Client mods are ready. Restart Kawaicord to apply them.'); })),
      divider(), heading('Recovery'), text(data.runtime.error ?? (data.runtime.safeMode ? 'Recovery mode is active. Your selected client mod is paused.' : 'Having trouble loading? Recovery mode keeps Shelter and temporarily pauses your client mod.')),
      buttons(button(data.runtime.safeMode ? 'Restart normally' : 'Restart in recovery mode', async () => { await invoke(data.runtime.safeMode ? 'restart_app' : 'restart_recovery'); })),
      component('Text', { tag: ui.TextTags.textSM, style: { color: 'var(--text-muted)' }, get children() { return notice(); } }));
    });
  }).catch(error => { if (!disposed) root.textContent = `Could not load Kawaicord settings: ${String(error)}`; });
  return root;
}
