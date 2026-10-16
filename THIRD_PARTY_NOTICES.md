# third-party notices

kawaicord includes browser distributions and data from these projects. those files retain their upstream licenses and copyright notices.

| component | upstream source | license |
| --- | --- | --- |
| shelter | https://github.com/uwu/shelter | cc0-1.0 |
| vencord | https://github.com/Vendicated/Vencord | gpl-3.0 |
| equicord | https://github.com/Equicord/Equicord | gpl-3.0 |
| illegalcord | https://github.com/ImHisako/Illegalcord | gpl-3.0 |
| arrpc game detection data | https://github.com/OpenAsar/arrpc | mit |
| tauri and official plugins | https://github.com/tauri-apps | mit / apache-2.0 |

vencord and equicord fallback distributions were refreshed on 14 october 2026. their headers identify vencord `16ec4ea` and equicord `e0e85c8d4f6dc73aac9368cf3f4b2200eac4d4b4`. illegalcord was downloaded on 16 october 2026 from its official browser release and retains its equicord fork header. shelter comes from https://github.com/uwu/shelter-builds.

corresponding client mod source is available at the upstream repositories above. the gpl license is included in `licenses/client-mods-GPL-3.0.txt`; browser distribution notices are retained with the bundles. updates use each project's official browser build location.

`native-data/games.json` is the executable detection subset of arrpc 3.6.0's `src/process/detectable.json`. its mit notice is in `licenses/arrpc-MIT.txt`. the rpc transport and native scanner in this repository are written in rust.

npm dependencies are pinned in `package-lock.json`; rust dependencies and their exact versions are pinned in `src-tauri/Cargo.lock`. those packages retain their own licenses. electron and electron-updater are no longer runtime dependencies in the native build.
