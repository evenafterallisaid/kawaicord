# Kawaicord

<p align="center">
  <img src="icons/icon.png" alt="Kawaicord mascot" width="144">
</p>

Kawaicord is a Windows desktop wrapper for Discord's web app with Discord-native window controls, always-on Shelter support, and one-click switching between Vencord and Equicord.

> [!IMPORTANT]
> Kawaicord is an independent, unofficial project. It is not affiliated with or endorsed by Discord Inc., Vencord, Equicord, or Shelter. Client modifications may violate Discord's Terms of Service; use them at your own risk.

## Highlights

- Shelter loads on every normal and recovery-mode start.
- Choose exactly one client mod: Vencord or Equicord.
- The selected mod is refreshed automatically, with cached and installer-bundled fallbacks.
- App updates are checked against GitHub Releases, downloaded with integrity verification, and installed on restart without replacing the user profile.
- Mod changes are applied through a guarded, clean process restart.
- Vencord and Equicord's own restart buttons are routed through the same restart path, including hard-reload variants used by newer bundles.
- Ctrl+R, Ctrl+Shift+R, and F5 use a controlled renderer refresh that shows a protected loading surface and verifies Shelter plus the selected client mod after every navigation.
- Discord's back/forward controls and a theme-proof drag region remain available in the shared app bar.
- Windows receives Discord's unread count as a taskbar overlay badge.
- Recovery mode keeps Shelter available while pausing a repeatedly crashing client mod.
- A UI health watchdog verifies that Discord actually mounted, retries one normal reload, then recovers without the selected client mod instead of leaving a blank window.
- The Windows controls live inside Discord's own platform-aware app bar, use crisp stock-style caption glyphs, follow its live theme tokens (including pure-black AMOLED themes), and reserve their space plus a small safety gap without covering navigation or toolbar actions.
- Window controls are isolated inside a closed shadow root, while a targeted layout guard prevents third-party themes from moving, hiding, or collapsing Discord's app bar and navigation controls.
- Background performance mode pauses decorative animation and avatar painting while hidden, suspends titlebar/theme visual maintenance, and restores it on show. Calls, messages, audio, and notification timers remain unthrottled by default.
- After a minute hidden, unused image-cache memory is reclaimed only when at least 64 MiB and half the cache are unused, and no audio/video element is playing. No renderer suspension, forced garbage collection, or periodic reloads are used for memory savings.
- Optional stronger background throttling is available for users who prefer battery savings.
- Window size, position, and maximized state are restored safely across monitor changes.
- Discord science and Sentry telemetry requests are blocked without interfering with normal API traffic.
- Hardware-accelerated rendering, video decode, and WebRTC encoding are enabled for smoother calls and screen sharing when supported, while Chromium's GPU safety fallback remains intact for unstable drivers.
- App updates, arRPC, tray behavior, startup behavior, and mod updates are configurable inside Discord settings.

## Install

Download `Kawaicord-Setup-<version>-x64.exe` from the latest GitHub release and run the installer. The assisted installer can create Start menu and desktop shortcuts and lets you choose the installation directory.

Kawaicord downloads Shelter plus the selected Vencord/Equicord browser bundle when an update is due. If the update service is unavailable, it uses the last known-good cached copy or the bundled fallback.

Mod refreshes happen after the window is created, so a slow mod CDN cannot hold up Discord startup. The cached or installer-bundled copy is used for the current launch and a newly downloaded copy is ready for the next controlled refresh or restart.

## App updates

Open Discord's settings and select **Kawaicord → Updates** to check manually or enable automatic app updates. Installed builds read integrity-checked update metadata from this repository's GitHub Releases. Downloads happen in the background and show progress in settings; Kawaicord installs a ready update when you choose **Restart and update** or exit normally.

The NSIS updater replaces application files only. Kawaicord configuration, Discord session storage, client-mod settings, and cached bundles stay in `%APPDATA%\kawaicord`, and the uninstaller continues to preserve that profile by default.

Kawaicord remains an independent client and does not forge official-client identity or quest progress. Features that Discord permits in its web client work normally, while arRPC supplies legitimate local Rich Presence information for supported games and applications.

## Switch Vencord and Equicord

1. Open Discord's settings.
2. Select **Kawaicord**.
3. Choose **Vencord** or **Equicord** under **Active Mod**.
4. Select **Restart** in the banner.

The old Electron process explicitly stops arRPC, flushes Discord storage with a bounded timeout, schedules the replacement, destroys the tray and window, and exits. If a replacement cannot be scheduled, Kawaicord keeps the current process usable and reports the failure instead of disappearing. This applies to Kawaicord's restart buttons and restart actions inside Vencord or Equicord. Only the selected client mod is injected after restart; Shelter is injected separately and remains enabled.

A normal renderer refresh does not restart the whole process. Kawaicord intercepts the standard refresh shortcuts, reloads Discord, and runs an idempotent injection check with automatic retries and a main-process watchdog. This prevents a refreshed window from silently coming back without Shelter, Vencord, or Equicord.

## Recovery and logs

Kawaicord records a small rotating log at:

```text
%APPDATA%\kawaicord\kawaicord.log
```

After a recent unclean exit, Kawaicord starts in recovery mode. Shelter still loads, but Vencord/Equicord is skipped for that session. Restart normally to try the selected mod again. A second renderer crash in one session also triggers this recovery behavior.

User settings, cached mod bundles, and Discord session data remain under `%APPDATA%\kawaicord`. Uninstalling does not delete that profile by default.

## Build from source

Requirements:

- Windows 10 or newer
- Node.js 22.12 or newer
- npm

```powershell
npm ci
npm run build
npm start
```

The install step downloads the matching Electron runtime automatically.

Create the Windows installer:

```powershell
npm run package
```

The NSIS installer is written to `build/`. For an unpacked smoke-test build, use `npm run package:dir`.

Tagged releases use `.github/workflows/release.yml`. A tag such as `v1.3.0` builds the NSIS installer and publishes it together with `latest.yml` and block-map metadata required by the updater.

## Project layout

```text
src/                 Electron main process, preload UI, arRPC bridge
plugins/settings/    Shelter settings-section bridge
shelter/             Bundled offline Shelter fallback
vencord/              Bundled offline Vencord fallback
equicord/             Bundled offline Equicord fallback
icons/                Vector logo sources plus app, installer, and tray artwork
```

`dist/`, `build/`, and `node_modules/` are generated locally and ignored by Git.

## Release checklist

```powershell
npm ci
npm test
npm audit --omit=dev
npm run package
```

GitHub Actions runs the same compile and Windows packaging flow and uploads the installer as a workflow artifact. Version tags additionally publish a GitHub Release with the updater metadata.

## License and credits

Kawaicord's original source code is available under the [MIT License](LICENSE). Bundled third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

- [Shelter](https://github.com/uwu/shelter)
- [Vencord](https://github.com/Vendicated/Vencord)
- [Equicord](https://github.com/Equicord/Equicord)
- [arRPC](https://github.com/OpenAsar/arrpc)
