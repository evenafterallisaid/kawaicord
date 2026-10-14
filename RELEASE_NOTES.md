Kawaicord 1.5.2 fixes client-mod startup on macOS and improves Discord loading recovery on both platforms.

- Refreshed the bundled Vencord, Equicord, and Shelter builds to support Discord's current startup hooks.
- Slow loads and network or certificate failures no longer disable the selected client mod for the rest of the session.
- Fixed readiness detection that could mistake a fully rendered Discord page for a failed load.
- Added a button in recovery-mode settings to restart with the selected client mod.
- Added lifecycle regression tests and an optional live Discord initialization check. Both Vencord and Equicord were verified with Shelter against Discord's sign-in page on macOS.

For a first Mac installation, open the DMG and drag Kawaicord to Applications. macOS builds are ad-hoc signed and are not notarized; first-launch Gatekeeper approval may be required. Windows builds remain unsigned.
