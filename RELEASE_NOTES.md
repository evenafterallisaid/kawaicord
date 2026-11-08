kawaicord 2.0.2 candidate. teaching spotify where its own play button lives.

- grouped the in-discord settings so the mod picker, notifications, and background controls stay up front.
- moved automatic update scheduling into the shared rust code. disabled checks now wait for a settings change, and linux releases startup scripts when their last window closes.
- listen along on a spotify computer device now sends the host track's album context when available. discord still owns the playback position and track changes, and this path needs no companion or automation. real spotify playback still needs a live check.
- added optional local spotify playback for the blank-player failure after an accepted remote play request. requires spotify premium and an existing spicetify installation.
- added companion setup to kawaicord settings. it backs up the spicetify configuration, adds the companion, and applies existing customization without restarting spotify automatically. quit and reopen spotify afterward, then enable listen along on this computer.
- the companion starts the target track, seeks to the listening position, follows track changes and temporary presence gaps, and releases control after a manual pause or song change. late remote playback responses trigger a fresh local repair instead of leaving spotify blank again.
- kept the integration off by default and limited it to the main window. it uses paired loopback messages and player events, with no separate background process or idle playback polling loop. spotify account tokens and friend/account identifiers are not sent through the bridge.
- added an opt-in native spotify path for macos apple events and linux mpris. no spicetify patch or extra spotify login is needed for that mode. macos may ask for automation permission. the companion remains available, including on windows.
- native playback checks the current track before seeking, resuming, or pausing, releases control after manual changes, and checks player state only while following a listening session.
- fixed temporary spotify presence loss being mistaken for a pause. new tracks now wait for actual playback before seeking, ignored native seeks get bounded retries with position checks, and track duration is retained for natural handovers.
- checked startup, synchronization, stale responses, pause/resume, manual overrides, reconnects, bounded drift correction, and paired websocket exchange in automated tests. the macos companion has a user-confirmed playback result; native playback is still experimental pending authenticated validation.

macos and windows use their native webviews; linux keeps the chromium host and shared rust service from 2.0.1. the spotify integration is shared, but real companion playback has not yet been verified on every operating system.
