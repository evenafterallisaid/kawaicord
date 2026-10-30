fn main() {
    let commands = &[
        "list_instances",
        "open_instance",
        "close_instance",
        "close_all_instances",
        "clear_instance_session",
        "report_instance_user",
        "cloud_request",
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
        "close_notification",
        "check_update",
        "install_update",
        "open_releases",
        "window_action",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(commands)),
    )
    .expect("Tauri build failed");
}
