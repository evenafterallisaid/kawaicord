# Kawaicord

<p align="center">
  <img src="icons/icon.png" alt="Kawaicord mascot" width="144">
</p>

Kawaicord is a Windows desktop wrapper for Discord's web app with a custom title bar, always-on Shelter support, and one-click switching between Vencord and Equicord.

> [!IMPORTANT]
> Kawaicord is an independent, unofficial project. It is not affiliated with or endorsed by Discord Inc., Vencord, Equicord, or Shelter. Client modifications may violate Discord's Terms of Service; use them at your own risk.

## Highlights

- Shelter loads on every normal and recovery-mode start.
- Choose exactly one client mod: Vencord or Equicord.
- The selected mod is refreshed automatically, with cached and installer-bundled fallbacks.
- Mod changes are applied through a full, clean process restart.
- Vencord and Equicord's own restart buttons are routed through the same clean process restart.
- Recovery mode keeps Shelter available while pausing a repeatedly crashing client mod.
- The Windows title bar follows Discord's live theme tokens, including pure-black AMOLED themes, and keeps Discord navigation fully unobstructed.
- Background performance mode lowers rendering to 10 FPS without throttling notification timers.
- Optional stronger background throttling is available for users who prefer battery savings.
- Window size, position, and maximized state are restored safely across monitor changes.
- Discord science and Sentry telemetry requests are blocked without interfering with normal API traffic.
- Hardware-accelerated rendering, video decode, and WebRTC encoding are enabled for smoother calls and screen sharing when supported.
- arRPC, tray behavior, startup behavior, and mod updates are configurable inside Discord settings.

## Install

Download `Kawaicord-Setup-<version>-x64.exe` from the latest GitHub release and run the installer. The assisted installer can create Start menu and desktop shortcuts and lets you choose the installation directory.

Kawaicord downloads Shelter plus the selected Vencord/Equicord browser bundle when an update is due. If the update service is unavailable, it uses the last known-good cached copy or the bundled fallback.

## Switch Vencord and Equicord

1. Open Discord's settings.
2. Select **Kawaicord**.
3. Choose **Vencord** or **Equicord** under **Active Mod**.
4. Select **Restart** in the banner.

The old Electron process explicitly stops arRPC, flushes Discord storage, destroys the tray and window, and exits before Electron starts the replacement process. This applies to Kawaicord's restart buttons and restart actions inside Vencord or Equicord. Only the selected client mod is injected after restart; Shelter is injected separately and remains enabled.

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

## Project layout

```text
src/                 Electron main process, preload UI, arRPC bridge
plugins/settings/    Shelter settings-section bridge
shelter/             Bundled offline Shelter fallback
vencord/              Bundled offline Vencord fallback
equicord/             Bundled offline Equicord fallback
icons/                App, installer, and tray artwork
```

`dist/`, `build/`, and `node_modules/` are generated locally and ignored by Git.

## Release checklist

```powershell
npm ci
npm test
npm audit --omit=dev
npm run package
```

GitHub Actions runs the same compile and Windows packaging flow and uploads the installer as a workflow artifact.

## License and credits

Kawaicord's original source code is available under the [MIT License](LICENSE). Bundled third-party components retain their own licenses; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

- [Shelter](https://github.com/uwu/shelter)
- [Vencord](https://github.com/Vendicated/Vencord)
- [Equicord](https://github.com/Equicord/Equicord)
- [arRPC](https://github.com/OpenAsar/arrpc)
