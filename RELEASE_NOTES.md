kawaicord 2.0.2 candidate. teaching spotify where its own play button lives.

- added optional local spotify playback for the blank-player failure after an accepted remote play request. requires spotify premium and an existing spicetify installation.
- added companion setup to kawaicord settings. it backs up the spicetify configuration, adds the companion, and applies existing customization without restarting spotify automatically. quit and reopen spotify afterward, then enable listen along on this computer.
- the companion starts the target track, seeks to the listening position, follows track changes and host pauses, and releases control after a manual pause or song change. late remote playback responses trigger a fresh local repair instead of leaving spotify blank again.
- kept the integration off by default and limited it to the main window. it uses paired loopback messages and player events, with no separate background process or idle playback polling loop. spotify account tokens and friend/account identifiers are not sent through the bridge.
- checked startup, synchronization, stale responses, pause/resume, manual overrides, reconnects, bounded drift correction, and a real paired websocket exchange in automated tests. real spotify playback validation is still pending; this candidate is not a confirmed fix or a published stable release yet.

macos and windows use their native webviews; linux keeps the chromium host and shared rust service from 2.0.1. the spotify integration is shared, but real companion playback has not yet been verified on every operating system.
