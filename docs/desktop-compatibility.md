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
