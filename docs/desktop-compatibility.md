# desktop compatibility investigation

inspected the public macos stable 0.0.420 package and its downloaded desktop core with the existing rea 6.8.0 cli. the application code was read as inert text, never launched or loaded as a native module. the results establish static integration points, not working quests.

| observation | consequence |
| --- | --- |
| the bootstrapper loads `discord_desktop_core` and invokes its startup entrypoint | the installer bootstrap alone does not contain the complete desktop client |
| the core preload exposes a large `DiscordNative` surface, including native modules, desktop capture, activity capture, settings, and process utilities | setting a desktop flag without implementing those contracts can select missing functionality, including the wrong voice engine |
| native module loading goes through an explicit module-name check and loader | node native modules cannot simply be required inside a tauri system webview |
| discord's web bundle loads `discord_game_utils`; process observation goes through `discord_utils` and `setObservedGamesCallback` | game identification includes executable and launch-argument matching, beyond the normal browser presence api |

kawaicord currently supplies its own rust rpc and optional process detector. this build fixes macos bundle matching, full linux executable names, shared-engine arguments, and launcher filtering. command lines are requested only for executable candidates that need them. the detector stays off by default and does no background polling while disabled.

the full official native-module contract, authenticated quest behavior, game capture, and platform-specific game integrations remain unverified. this build does not advertise an implemented `DiscordNative` surface or promise desktop quest compatibility. no quest completion telemetry was fabricated.

## evidence

- official installer: `https://discord.com/api/download/stable?platform=osx`
- official core: `https://discord.com/api/modules/stable/discord_desktop_core/1?host_version=0.0.420&platform=osx&arch=arm64`
- bootstrap asar sha256: `c521563dc6401fa5d0bc342be97b340611b12c13891861e9b31814f62f7f0825`
- core asar sha256: `cbfd3f8ac60fe65ba9b54e41b8a38c312cad0642495545dd21ed1857955475db`
- bootstrap rea evidence: `ev_53dcd59bfbe20b1e61cd780c22f4afe7fae1a62de9fe4715daa94ce5db529111`
- selected core preload rea evidence: `ev_8c9f1ee7d2bc693a0e6bcaa433f2cf6b57de7845ac2bc9e22a91f49447a08b5a`

rea retained parsed module facts but reported partial graph coverage and bounded semantic extraction. source inspection corroborated the named calls. absent graph relationships were not treated as evidence of absent behavior. complete local reports and the source-offset ledger are retained outside the repository under `work/native-tools/`.

## spotify listen along follow-up, 2026-10-31

the official macos download endpoint still selected version 0.0.420. a new rea pass selected `bundle.js` and `package.json` from the retained desktop core. its main window constructs a hosted discord app url and passes it to electron's `loadURL`. this explains why inspecting the installer alone does not recover the playback implementation.

the current public hosted app selected `web.f86c748842ee176f.js`. three relevant factories were extracted as inert source slices, with original hashes and character ranges recorded alongside them, and analyzed with rea:

| inspected path | observation |
| --- | --- |
| spotify store, factory 655116 | selects an active spotify device, starts synchronization through the spotify api helper, and consumes spotify dealer websocket playback events; no desktop platform branch was found within this factory |
| playback api, factory 107750 | sends the target uri and position to the spotify player api and optionally updates repeat; its explicit desktop branch checks whether the spotify url protocol is registered |
| device startup, factory 981616 | immediately returns an existing active socket/device; otherwise it can select an observed spotify desktop device or launch spotify and wait for a device |
| playback-state handler within factory 655116 | schedules stopping listen along after five seconds when reported playback stays stopped with a nonzero position, lacks a device, or changes to another track |

in the running 2.0.1 mac client, the existing diagnostic showed a connected account, an available device, an open realtime socket, premium access, and a play response of http 204. a later refresh showed synchronization inactive with the same successful response. the tester reported spotify's playback bar becoming blank. http 204 confirms request acceptance, not audible playback. this observation does not identify which later playback-state condition ended the session.

the inspected path therefore does not establish a missing desktop-only playback routine to transplant. native device discovery and protocol launching can be implemented through kawaicord's typed bridge when needed, but an electron/node module is not a drop-in tauri webview component. the already-active-device path reaches the shared playback api without that startup fallback. copying that path would not establish a fix for the observed post-acceptance failure.

the cause remains unresolved. an authenticated comparison with official discord and a comparison using spotify's web player have not been performed. reported spotify 1.3.x failures with similar symptoms are supporting context, not proof that this mac's failure has the same cause. no playback workaround or new fixed release is claimed by this investigation.

### evidence and limits

- desktop core rea evidence: `ev_3db131331cf76fa8c3d38868e4e5023a5db5dfca03408d4c840d57d051bc14ba`
- selected hosted spotify factories rea evidence: `ev_b78dd60e0c1109b9337ca47d327a512b68f798768d4cf24544b5715c43d5c99b`
- hosted source: `https://discord.com/assets/web.f86c748842ee176f.js`
- hosted source sha256: `aa14007778d9c1e5650efbb23086ff9ee0c95beb62ec13d1e5ec1cbe1fb1486b`
- complete local evidence bundles: `work/native-tools/spotify-desktop-rea.json` and `work/native-tools/spotify-web-rea.json`; extracted factories and provenance: `work/native-tools/spotify-rea-selected/`

both passes reported zero parse failures. desktop semantic retention was bounded, and both graphs retained unresolved relationships. the findings above are supported by selected source inspection, not complete native-module coverage or an observed official-client call. the selected hosted factories were wrapped for inert parsing; their original slices and provenance remain separate from that wrapper. proprietary client code and authentication data were not added to this repository.
