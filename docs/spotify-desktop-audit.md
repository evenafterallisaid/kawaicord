# spotify desktop audit, 2026-11-01

the 2.0.2 macos candidate's optional local-player companion now has a user-confirmed successful playback result. that confirms the workaround on this machine. it does not establish that official discord or legcord has the same failure, that the underlying spotify problem is diagnosed, or that every transition has been tested live.

## questions and coverage

| question | result | boundary |
| --- | --- | --- |
| did the previous investigation cover the whole desktop core? | no. this pass analyzed every javascript source in the retained macos core asar | three javascript files and package metadata parsed with zero parse failures; semantic graph coverage remains partial |
| is there a desktop-only spotify startup path? | yes. protocol registration and observed applications help find or launch a spotify computer device | hosted factories 339586, 952818, 981616, 19575, and their protocol/platform helpers |
| does the already-active-device path need that startup fallback? | the inspected function returns its existing socket/device before the fallback | static branch order, not a live official-client comparison |
| what does the native protocol check do on macos? | it constructs a url, asks `NSWorkspace.URLForApplicationToOpenURL`, and returns whether a handler exists | decompiled arm64 function at `0xf128`, corroborated by its napi registration and hosted caller |
| does playback use a different native spotify routine on desktop? | no such routine was established in the inspected path. playback submits a spotify player request; dealer events feed the shared spotify store | this is a bounded finding, not proof about every native module or future hosted bundle |
| does legcord supply a local spotify playback fix? | none found in the reviewed source revision | source inspection only; downloaded mods and arbitrary runtime plugins can change behavior |
| does legcord actually have the blank-player bug? | unverified | no authenticated legcord playback test was performed |
| would injection into official discord remove spicetify? | possible if its normal playback works on the same setup; unverified | no authenticated official-client comparison was performed |

## expanded official-client inspection

the public download endpoints selected macos 0.0.420, windows x86 1.0.9059, and linux 1.0.168 during this pass. those endpoint identities do not establish windows or linux binary coverage. the macos core matched the previously retained sha256, so its existing artifact was reused.

all three javascript files in `core.asar` were submitted to rea without a source selection. the bootstrap, core, and the javascript wrappers from `discord_utils`, `discord_game_utils`, and `discord_rpc` were also formatted locally as inert source. the original hashes and factory ranges are retained separately. formatting improves readability; it does not restore original typescript, comments, symbols, or project structure.

the current public app html still selected `web.f86c748842ee176f.js`. a static ast inventory recorded 4,922 numeric function-property candidates in that bundle, then retained 43 spotify-related or explicitly selected factories for inspection. six additional protocol, device, platform, and metadata factories were submitted to rea. the native adapter and platform implementation were separately read from their original ranges. factory candidates and string matches are discovery aids, not a complete behavioral graph.

the inspected startup chain is:

1. use an existing active spotify socket/device when available.
2. otherwise check spotify's registered url protocol.
3. if spotify is an observed running app, select an available computer device.
4. otherwise launch the protocol and wait for a new computer device.
5. submit the target uri and position through the spotify player api. dealer websocket events update the spotify store.

the desktop protocol check reaches `discord_game_utils.isProtocolSchemeRegistered`. running-app observation reaches `discord_utils.setObservedGamesCallback` or its newer callback variant. those are real desktop integrations worth accounting for. the earlier failed kawaicord attempt already reported an active device and an accepted http 204 play request, so their existence does not itself explain that failure.

the actual desktop platform test reads `window.DiscordNative` and its process platform. changing a user agent does not implement that native contract. the adapter also requests native voice and other modules. a compatibility shim needs implemented contracts and feature-specific validation before selecting those branches.

the arm64 slice of `discord_game_utils` was imported into ghidra 12.1.4 through rea. the export inventory contains 847 function records: 689 pseudocode files were written and 158 external records were skipped. there were no failed function exports. these are the functions discovered by that analysis, not a proof that every machine-code function was identified.

the napi registration names `isProtocolSchemeRegistered`, its wrapper reaches the implementation at `0xf128`, and that implementation constructs a url and asks `NSWorkspace.URLForApplicationToOpenURL` whether an application handles it. it returns a boolean. this establishes that this particular native check is operating-system app discovery, not a separate spotify playback or synchronization engine. the source container and selected arm64 slice have separate hashes, and the original artifact was not modified.

the arm64 `discord_utils` export contains 2,570 discovered function records: 2,312 pseudocode files were written and 258 external records were skipped, with no failed exports. the observed-game callback wrappers at `0x17d38` and `0x181c8` dispatch process-observation work. the inspected `ProcessObserver` constructor starts a five-second libuv timer, and `PlatformPollNow` at `0x6ce68` enumerates `NSWorkspace.runningApplications`, process identifiers, and bundle or executable urls. this corroborates the running-app discovery contract. it does not establish a separate spotify playback routine or reproduce the original failure.

the portable analysis toolchain uses checksum-verified ghidra and temurin archives, with the macos arm64 decompiler built locally from that ghidra archive. no global rea registration, application installation, shell profile, or discord setting was changed. analysis tools execute; the discord libraries were imported as data and never executed.

## legcord comparison

reviewed [legcord revision a5f0a9c](https://github.com/Legcord/Legcord/tree/a5f0a9c3b5d6adab74e203656ed8b51bd831ccb2), whose package version is 1.3.1. the source tree contains 141 files. a case-insensitive search for spotify and listen-along terms found the spotify embed permission in its content security policy, with no matching playback implementation in the checked-out tree.

- [window host](https://github.com/Legcord/Legcord/blob/a5f0a9c3b5d6adab74e203656ed8b51bd831ccb2/src/discord/window.ts) sets a chromium user agent and loads the hosted discord app, ptb, or canary page.
- [mod configuration](https://github.com/Legcord/Legcord/blob/a5f0a9c3b5d6adab74e203656ed8b51bd831ccb2/src/common/consts.ts) selects browser builds of vencord and equicord.
- [preload bridge](https://github.com/Legcord/Legcord/blob/a5f0a9c3b5d6adab74e203656ed8b51bd831ccb2/src/discord/preload/bridge.ts) exposes legcord-specific controls rather than the official `DiscordNative` implementation.

this makes legcord a useful comparison of a chromium-based custom host, not a source for the official client's complete native spotify implementation. there is no established legcord-specific fix to port from this revision. the github issue searches `spotify` and `"listen along"` did not return a report matching the blank-player failure. search absence does not establish working playback.

legcord also has an [open report about missing official activity history and streak behavior](https://github.com/Legcord/Legcord/issues/1168). that is a reporter's observation, not a reproduction here, but it reinforces why rich presence alone should not be advertised as full official-client feature compatibility.

## spotify soloist

[spotify soloist](https://developer.spotify.com/documentation/soloist) is a useful additional comparison. it is an official headless spotify connect receiver that plays through its own process. it does not add a control interface to an existing spotify desktop process. the inspected public [repository revision d2de4e6a](https://github.com/spotify/soloist/tree/d2de4e6ad117b9cfa684616899f11d8f59815c82) contains a readme, not the playback engine's source.

its documented [local websocket api](https://developer.spotify.com/documentation/soloist/reference/websocket-api) supports track-uri playback, pause, seek, active-device selection, and pushed track/playback/position events. those cover the controls our listening feed needs in principle. command acceptance is explicitly separate from playback success, so an adapter must confirm the target track, playing state, and advancing position rather than treating `command_result` as successful playback.

the smallest proposed experiment is to select soloist as the active spotify connect device and retry normal discord listen along with the local repair disabled. if that works, it would narrow the failure to the desktop playback path without requiring a new kawaicord player adapter. if it fails but soloist's local controls work, a rust adapter could drive its local api from the existing listening feed. both are untested proposals, not implemented or validated integrations.

distribution and setup constraints in spotify's current documentation:

- [authentication](https://developer.spotify.com/documentation/soloist/concepts/authentication) requires every user to generate their own soloist key; creating that key requires premium. a shared application key is not a supported replacement.
- [downloads](https://developer.spotify.com/documentation/soloist/reference/downloads-and-updates) cover linux arm32, arm64, and x86_64, apple silicon macs, and x86_64 windows. there is no intel mac build in the published list. spotify says to link users to its downloads rather than redistributing the binaries in our release.
- [build lifetime](https://developer.spotify.com/documentation/soloist/concepts/overview) is 90 days from the build date. an expired daemon exits, so update handling is a functional requirement.
- the local websocket api has no client authentication or origin validation. any future integration needs native ownership and a reviewed local-control boundary; it should not expose that socket or its startup key directly to discord's hosted page.

soloist may remove the spicetify modification requirement for users willing to use a separate official playback device. it does not yet establish a smaller total memory footprint, fix ordinary spotify desktop playback, or supply discord desktop-only features. no soloist binary was installed or run, no developer key was requested, and no account pairing was performed during this documentation review.

## evidence and remaining checks

- all-core rea evidence: `ev_6618a28c144615c394ac351d1fda8f8e8b462652dc70b209d31a3d8ce6dd1ae6`
- extended hosted factories rea evidence: `ev_62eb11e5303c99e546dc9fe006a071a9c0d0a01fbd7951dea7164d35c3a7d01a`
- macos game utility metadata: `ev_e933850b138d5839ed976b668e3c3a44afe0d34ce87482f57f9f943d15abe056`
- macos arm64 game utility pseudocode export: `ev_351be91479f9e0513ee79737228c9c7248d4b1ff333022e51b1e5d6c22bcfac7`
- arm64 game utility slice sha256: `61ff24ac1da36951457db481dbfc4baee5aa04332d767210cbdb07df3a94540e`
- macos arm64 process utility pseudocode export: `ev_27d33c063d5457af7e6242735fcf5c4f1f3db902f4d581cd5fec5e11a59a74db`
- arm64 process utility slice sha256: `875274655a427123c13bd9b54c838731720b97b361f6d1de4c849f69241dd1c1`
- core sha256: `cbfd3f8ac60fe65ba9b54e41b8a38c312cad0642495545dd21ed1857955475db`
- hosted bundle sha256: `aa14007778d9c1e5650efbb23086ff9ee0c95beb62ec13d1e5ec1cbe1fb1486b`
- complete local evidence, download provenance, readable-source ledger, and native inventories: `work/native-tools/discord-broader-nov01/`

required live comparison: same mac, spotify version, account, and host listening session, first using unmodified official discord and then legcord, with kawaicord's local repair disabled. record actual playback and position, a host track change, and the point where any session ends. neither a successful http response nor an open listen-along panel is sufficient. this comparison remains outstanding; no extra client was installed or launched by the static audit.

this is not a complete decompilation of discord, electron, chromium, every downloadable native module, or discord's remote services. no proprietary client code, reconstructed source, account credentials, or downloaded executable is committed to this repository.
