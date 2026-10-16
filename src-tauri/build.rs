fn main() {
    let commands = &[
        "show_discord",
        "open_settings",
        "reload_discord",
        "restart_app",
        "restart_recovery",
        "get_settings",
        "save_config",
        "refresh_mods",
        "report_runtime",
        "set_unread",
        "notification_permission",
        "notify",
        "check_update",
        "install_update",
        "open_releases",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("Tauri build failed");
}
