kawaicord 2.0.2. the windows installer has had its coffee.

- refreshed the bundled vencord, equicord, and illegalcord builds for current discord startup. older downloaded copies no longer override the fresh installer bundles.
- added a dark startup background and local recovery on macos and windows if discord stalls. recovery is also available from the tray menu.
- tidied kawaicord settings inside discord. the mod picker, notifications, and background controls stay up front.
- moved automatic update scheduling to shared rust code. disabled checks wait for a settings change. linux also drops the separate cache of startup scripts.
- adjusted the discord listen along request for spotify desktop when the host track has album metadata. the app still uses discord's sync and playback position. this path needs no companion or automation, and real spotify playback still needs a live check.
- kept optional spotify playback controls in settings. the spicetify companion is available on all three platforms. macos automation and linux mpris are experimental alternatives. both modes are off by default, and listen along requires spotify premium.

macos and windows use their system webviews. linux keeps chromium with the shared rust helper.
