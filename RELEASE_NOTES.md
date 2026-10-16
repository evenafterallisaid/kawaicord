kawaicord 2.0.0-beta.2. the coffee is doing most of the work.

- replaced the electron host with rust and tauri on macos, windows, and linux. the app uses the system webview and has no node sidecar.
- added illegalcord alongside vencord and equicord. shelter still loads separately.
- kept hcaptcha frames inside discord so verification no longer opens an external browser.
- macos finally gets actual native traffic lights and a native titlebar.
- calls, messages, audio, and notifications stay live when hidden. background mode only pauses decorative drawing.
- restored settings inside discord with shelter’s theme-aware controls. removed the floating corner button.
- bundled illegalcord’s actual badge image instead of loading a github file page.
- added illegalcord’s multi-instance helper through native windows and separate session stores.
- moved tray integration, startup preferences, notifications, rpc, and signed updates into the native host.
- fixed official cloud oauth configuration requests and bundled the equicord and vencord cloud logos.
- added a static nameplate fallback on macos for correct transparency. animation is unavailable with this fallback.
- game detection is optional and disabled by default to avoid background scanning.
- added universal mac installers, windows x64 installers, and linux x64 deb and appimage packages to one release pipeline.

this is the first native preview. install it manually and sign in again; the 1.x profile is retained separately. v1.5.2 remains the stable release. do not run both clients at once unless you enjoy duplicate notifications.

startup smoke checks cover the real discord sign-in page, shelter, all three client mods, and media api availability. authenticated calls and screen sharing still need real usage on each platform. webview media support varies with the os, codecs, and permissions.

mac builds are ad hoc signed and are not notarized. first launch may require approval in system settings. windows builds are unsigned. native updater payloads are signed with the project's update key.
