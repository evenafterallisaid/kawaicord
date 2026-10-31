kawaicord 2.0.1. the coffee finally got a release build.

- stopped spotify previews from launching browser tabs when opening dms or scrolling. embedded previews stay inside discord; deliberate external links retain their normal behavior.
- replaced the electron host with rust, tauri, and a small typescript bridge on macos and windows. linux uses chromium with the same rust service because stable webkitgtk cannot run discord voice reliably. the linux package is larger; macos and windows keep their system webviews.
- fixed macos identifying itself as an unknown webkit client, which made discord reject voice calls as an unsupported browser. the app now reports the installed safari version and allows incoming audio playback.
- added the microphone and camera entitlements to signed mac builds. without them, macos denied microphone access before it could show a permission prompt.
- restored spotify app and media launch links, which the native navigation handler was dropping. added a read-only spotify connection check that distinguishes playback rejection from lost sync without recording credentials or changing playback. this does not claim to fix spotify desktop playback bugs.
- added a local audio transport diagnostic in settings. it uses synthetic audio, keeps the microphone closed, and sends nothing to another person.
- restored the discord-style frame and window controls on windows and linux. macos keeps its native traffic lights.
- repaired notification delivery after changing settings and restored notification click callbacks. permission checks run on settings and focus changes; callback storage is bounded.
- cleaned up settings into background, desktop, update, and recovery sections using discord-style controls. button labels stay inside their buttons.
- saved first-install defaults explicitly. discord stays live when hidden, notifications and local rpc are on, game scanning and login startup are off. existing preferences survive upgrades, and broken configuration files are backed up before recovery.
- made preview updates opt-in. update checks compare versions instead of publication order, reject overlapping operations, time out stalled requests, and keep the pending update available after an installation failure so you can retry. retrying starts a fresh download.
- kept install and restart under your control. background update checks never restart a call.
- added illegalcord alongside vencord and equicord, with shelter loaded separately. restored the actual illegalcord and cloud logos, native multi-instance sessions, and official cloud oauth configuration requests.
- kept captcha frames inside discord, removed the floating settings button, and gave macos its native titlebar and traffic lights.
- retained the macos static nameplate fallback for transparent video compositing. animation can be enabled in settings if your webview handles it correctly.
- packaged universal macos installers, windows x64 installers, and linux x64 deb and appimage builds. every platform must pass build, regression, live mod startup, settings, cloud configuration, and instance-isolation checks before publication. each platform also checks discord’s voice engine and encrypted media apis; macos verifies signed capture entitlements. linux also runs synthetic audio loopback and a hidden-window connection check in ci. a real macos call was confirmed separately from headless ci.

- fixed game detection for macos app bundles, long linux executable names, and shared engines that need exact launch arguments. launchers no longer masquerade as running games.

upgrading from 1.x requires a downloaded installer and a new sign-in. the old profile is retained separately. close the old client first to avoid duplicate notifications and competing rpc listeners. native beta installations keep their existing native profile.

microphone, camera, screen sharing, codecs, and encrypted voice support still depend on the operating system and webview. the automated audio test checks local transport; it is not an authenticated discord call on every platform. keep your system webview current.

mac builds are ad hoc signed and are not notarized. first launch may require approval in system settings. windows installers are unsigned. native updater payloads are signed with the project's update key. linux appimage installs support the updater; deb installations use a downloaded deb package.
