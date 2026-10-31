# kawaicord

<p align="center"><img src="icons/icon.png" alt="kawaicord mascot" width="144"></p>

discord, shelter, and your choice of vencord, equicord, or illegalcord. now with a rust host, tauri, a small typescript bridge, and slightly less coffee spilled into the runtime.

## the native rewrite

2.0 is the native client for macos, windows, and linux. the previous electron release is available as [v1.5.2](https://github.com/evenafterallisaid/kawaicord/releases/tag/v1.5.2).

- macos uses wkwebview and the real native titlebar, including the three traffic lights. browser identification follows the installed safari version so discord can recognize voice support.
- windows uses the system webview2 runtime and native window controls.
- linux uses a chromium host with the same rust service, with deb and appimage builds in the same release pipeline. stable webkitgtk lacks the voice transport discord requires, so the linux package deliberately includes chromium.
- shelter loads separately from the selected client mod, including in recovery mode.
- mod updates download after startup. complete cached pairs and installer copies provide fallbacks.
- closing the window keeps discord live by default. calls, messages, audio, and notifications are never deliberately suspended or unloaded to save memory.
- background performance mode pauses decorative animations and image painting while hidden. it restores them when shown.
- on macos, static nameplates preserve transparency where webkit cannot composite transparent vp9 videos. the setting can be changed inside kawaicord settings.
- illegalcord’s multi-instance helper opens native windows with isolated sessions. saved isolated sessions on macos require macos 14 or newer; temporary sessions work on older versions. detached windows work on all three platforms, and grouped native tabs are available on macos.
- official equicord and vencord cloud requests use a restricted native bridge, so discord’s page policy does not block oauth setup. cloud authorization still happens through the mod’s regular discord dialog.
- rust rpc accepts activity from local applications. macos and windows do not need a node sidecar. automatic game detection is optional and off by default; enabling it checks executable paths every 30 seconds. macos bundle paths and full linux executable names are matched, with exact argument checks for shared game engines. command lines are read only for matching candidates and are never logged.
- settings live inside discord’s own settings sidebar and use shelter’s discord-style controls and your current theme. a local recovery window is available if discord cannot initialize. the native bridge exposes typed app actions without filesystem or shell access.
- native releases use signed updater payloads. automatic checks never install an update or restart a call on their own.

using a system webview removes the bundled chromium and node runtime. discord, client mods, and the webview still use memory. actual savings depend on your platform, account, plugins, and active calls. a small host process alone is not a measurement of total app memory.

## install

get packages from [releases](https://github.com/evenafterallisaid/kawaicord/releases). stable installations receive stable updates by default. experimental releases are available separately as prereleases.

| system | package | requirements |
| --- | --- | --- |
| macos | universal `.dmg` | macos 12 or newer, intel or apple silicon |
| windows | `x64-setup.exe` | windows 10 or newer, webview2 evergreen runtime |
| linux | `.deb` or `.AppImage` | x86_64, bundled chromium; ubuntu 22.04 or newer recommended |

mac builds are ad hoc signed and are not notarized. the first launch may need approval through system settings, privacy & security. windows installers are unsigned. on linux, mark the appimage executable before opening it; the deb package installs its system dependencies through the package manager. linux uses a new isolated chromium session store; older webkit login data stays on disk, and an upgrade from that engine requires signing in again.

the native app uses a separate profile from 1.x. **you will need to sign in again**, and existing electron mod settings are not automatically migrated. the old profile is retained. close the old client before using the new one to avoid duplicate notifications and competing rpc listeners.

this is an unofficial discord client. upstream client mods keep their own licenses and compatibility constraints. microphone, camera, codecs, and screen sharing depend on the system webview and os permissions. startup checks exercise the live discord sign-in page, shelter, the selected mod, and media api availability. they do not prove an authenticated voice or screen sharing session works on every desktop.

## settings and recovery

open discord settings with the native settings menu or `cmd+,` / `ctrl+,`, then choose **kawaicord → settings**.

choose vencord, equicord, or illegalcord, then save and restart. exactly one client mod loads alongside shelter. the mods' restart buttons and the usual reload shortcuts use the native host.

updates are checked after startup and then every six hours. open settings to check manually and choose when to install. enable **receive preview updates** to include prereleases. this is off by default on new and existing installations. release selection compares version numbers rather than publication dates, and failed installations can be retried without another check. downloads are verified before installation; automatic checks never restart the app. the electron updater cannot install the native rewrite, so the initial migration uses a downloaded installer. appimage installs support native updates; deb installations should be updated with a new deb package.

first launch saves the default settings: notifications, local rpc, background drawing reduction, tray integration, and update checks are enabled. login startup and game detection are disabled. static nameplates are enabled on macos. existing preferences are retained; malformed settings are backed up before recovering defaults.

**test audio transport** in settings runs a local synthetic audio loopback without opening the microphone or contacting another person. it checks transport, not a complete discord call or permission setup.

**check spotify connection** reads the current spotify connection, active-device availability, and the last playback request’s http status. use it after a failed listen along attempt in the same app session. it does not start playback, reconnect accounts, or record access tokens, device ids, or track data. spotify app launch links are routed to the registered spotify application.

**listen along on this computer** is an optional workaround for spotify desktop accepting a remote play request but showing a blank player. it requires spotify premium and an existing [spicetify installation](https://spicetify.app/). in kawaicord settings, click **install spotify companion**, quit and reopen spotify, then enable **listen along on this computer**. setup preserves a backup of your spicetify configuration, appends its extension, and applies your existing customization without restarting spotify automatically. removing the extension uses `spicetify config extensions kawaicordListenAlong.js-` followed by `spicetify apply`.

the companion uses spotify's player to start the selected track and seek to the listening position. it follows track changes, handles a host pause, and gives up control if you pause or change tracks yourself. the main kawaicord window owns this integration; additional discord instances use their normal spotify behavior. the workaround is off by default. its paired connection stays on `127.0.0.1`, accepts only spotify's client origin, and carries the selected track and timing in memory. no spotify login tokens or friend/account identifiers are sent through it. it uses player events and pushed updates rather than an idle playback polling loop. the approach was informed by the independently published [local-player bridge](https://github.com/rajb16/discord-spotify-listen-along); kawaicord's implementation is separate.

recovery mode keeps shelter while skipping the client mod. use it from settings if a plugin breaks startup. a recent unclean app exit also enables recovery for that launch. slow downloads never disable a mod. on macos, a crashed web content process gets one reload, then one recovery attempt; repeated crashes stop the reload cycle and open settings.

profiles and the rotating `kawaicord.log` are stored in:

- macos: `~/Library/Application Support/com.kawaicord.native/`
- windows: `%APPDATA%\com.kawaicord.native\`
- linux: `$XDG_DATA_HOME/com.kawaicord.native/`, normally `~/.local/share/com.kawaicord.native/`

`--safe-mode` requests recovery, `--profile <directory>` selects a diagnostic configuration directory, and `--smoke-test` uses a temporary webview session and exits after reporting startup status. on macos, persistent webkit storage is associated with the app identifier; changing `--profile` alone does not isolate discord cookies.

## build it

install node 22.12 or newer, npm, stable rust with rustfmt and clippy, and the [tauri platform prerequisites](https://v2.tauri.app/start/prerequisites/). windows needs the microsoft c++ build tools. macos needs xcode command line tools.

on ubuntu:

```sh
sudo apt install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev libxdo-dev libssl-dev patchelf
```

then:

```sh
npm ci
npm test
npm start
```

create packages on the matching platform:

```sh
npm run package:windows
npm run package:linux
rustup target add aarch64-apple-darwin x86_64-apple-darwin
npm run package:mac
```

installers go under `src-tauri/target/`, in the release bundle directory for the chosen target. updater artifacts require `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. for an unsigned development package, disable updater artifact generation:

```sh
npm run tauri -- build --config '{"bundle":{"createUpdaterArtifacts":false}}'
```

`npm test` checks typescript, rust formatting, regression tests, and clippy. `npm run test:discord -- /absolute/path/to/kawaicord` opens isolated sign-in sessions for all three client mods, reports actual initialization, and exits. linux needs a graphical session or `xvfb-run -a`. it never uses an existing discord login. add `--integration` to check settings layout, cloud configuration, and separate instance storage, or `--media` to send synthetic audio through a local peer connection. the pipeline checks discord’s voice engine and encrypted media apis in each packaged app; macos also checks safari identification and signed microphone/camera entitlements. `--media` requires an interactive desktop with local network access. hosted mac runners may not expose usable local ice candidates, so macos ci uses `--media-preflight` rather than claiming a successful audio session. linux ci also sends real synthetic audio through chromium with a pulse audio test sink.

## releases

`.github/workflows/native.yml` builds all three platforms. macos packages are universal, windows uses nsis, and linux publishes deb plus appimage. every package must build and all three live mod startup checks must pass on each platform before the release workflow publishes the draft. native updater metadata is `latest.json`, with signed platform payloads.

version tags must match `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`. tags with a suffix such as `v2.1.0-beta.1` publish prereleases and leave the current stable release unchanged.

## source and credits

`src-tauri/` contains the rust host, desktop integration, rpc, bundle cache, and updater. `linux-host/` contains the linux chromium adapter with sandboxed, isolated renderers and a private pipe to the shared rust service. `native-ui/` contains settings and the document-start typescript bridge. `native-data/` holds the optional game detection list. the three mod directories and `shelter/` contain installer fallbacks. generated assets, build output, and dependencies are ignored by git.

original kawaicord source is [mit licensed](LICENSE). bundled mods keep their upstream licenses. see [third-party notices](THIRD_PARTY_NOTICES.md), including [shelter](https://github.com/uwu/shelter), [vencord](https://github.com/Vendicated/Vencord), [equicord](https://github.com/Equicord/Equicord), [illegalcord](https://github.com/ImHisako/Illegalcord), and [arrpc](https://github.com/OpenAsar/arrpc).
