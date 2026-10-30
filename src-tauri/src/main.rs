#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
mod activity_host;
mod bundles;
mod cloud;
mod cloud_client;
mod config;
mod diagnostics;
mod games;
mod instances;
mod navigation;
mod release_feed;
mod rpc;
mod updater;
use config::{Config, Recovery, WindowState};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::menu::{MenuBuilder, SubmenuBuilder};
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindow, WindowEvent};
use tauri_plugin_autostart::ManagerExt as AutostartExt;
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_opener::OpenerExt;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub active_mod: config::ClientMod,
    pub safe_mode: bool,
    pub shelter: bool,
    pub modules: usize,
    pub ready: bool,
    pub media: bool,
    pub screen_sharing: bool,
    pub error: Option<String>,
    pub version: String,
    pub platform: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_elapsed: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_hidden: Option<bool>,
}
struct AppState {
    profile: PathBuf,
    window_state: Mutex<WindowState>,
    config: Arc<Mutex<Config>>,
    runtime: Mutex<RuntimeStatus>,
    quitting: AtomicBool,
    refreshing: AtomicBool,
    #[cfg(target_os = "macos")]
    renderer_crashes: std::sync::atomic::AtomicUsize,
    config_changed: Arc<tokio::sync::Notify>,
    services: tokio::sync::Mutex<Option<rpc::Service>>,
    smoke: bool,
}
impl AppState {
    fn log(&self, message: &str) {
        let path = self.profile.join("kawaicord.log");
        if fs::metadata(&path).is_ok_and(|m| m.len() > 1024 * 1024) {
            let _ = fs::rename(&path, self.profile.join("kawaicord.log.1"));
        }
        if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(f, "[{}] {message}", config::now());
        }
    }
    fn recovery(&self, clean: bool) {
        let _ = config::save_json(
            &self.profile.join("recovery.json"),
            &Recovery {
                clean_exit: clean,
                updated_at: config::now(),
            },
        );
    }
}
fn trusted(window: &WebviewWindow) -> bool {
    (window.label() == "main" || window.label().starts_with("instance-"))
        && window.url().is_ok_and(|u| {
            u.scheme() == "https"
                && u.host_str().is_some_and(|h| {
                    matches!(h, "discord.com" | "ptb.discord.com" | "canary.discord.com")
                })
        })
}
fn local(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "settings"
        && window
            .url()
            .is_ok_and(|u| u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost"))
    {
        Ok(())
    } else {
        Err("This action is available only in the local settings window".into())
    }
}
fn either(window: &WebviewWindow) -> Result<(), String> {
    if trusted(window) {
        Ok(())
    } else {
        local(window)
    }
}
fn background(window: &WebviewWindow, hidden: bool) {
    let _ = window.eval(format!("window.__kawaicordSetBackground?.({hidden})"));
}
fn show(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        background(&w, false);
        let _ = w.set_focus();
    }
}
fn clean_exit(app: &AppHandle) {
    if let Some(state) = app.try_state::<AppState>() {
        state.quitting.store(true, Ordering::Relaxed);
        state.recovery(true);
        if let Ok(saved) = state.window_state.lock() {
            let _ = config::save_json(&state.profile.join("window.json"), &*saved);
        }
    }
}
#[derive(Serialize, PartialEq)]
struct ChromeState {
    maximized: bool,
    focused: bool,
}
#[derive(Deserialize)]
#[serde(rename_all = "lowercase")]
enum WindowAction {
    State,
    Minimize,
    Maximize,
    Close,
    Drag,
}
fn chrome_state(window: &WebviewWindow) -> ChromeState {
    ChromeState {
        maximized: window.is_maximized().unwrap_or(false),
        focused: window.is_focused().unwrap_or(false),
    }
}
fn report_window_state(window: &WebviewWindow, previous: &Mutex<Option<ChromeState>>) {
    #[cfg(not(target_os = "macos"))]
    {
        let state = chrome_state(window);
        if let Ok(mut previous) = previous.lock() {
            if previous.as_ref() != Some(&state) {
                if let Ok(serialized) = serde_json::to_string(&state) {
                    let _ = window.eval(format!("window.__kawaicordWindowState?.({serialized})"));
                }
                *previous = Some(state);
            }
        }
    }
    #[cfg(target_os = "macos")]
    let _ = (window, previous);
}
#[tauri::command]
fn window_action(window: WebviewWindow, action: WindowAction) -> Result<ChromeState, String> {
    if !trusted(&window) {
        return Err("Untrusted renderer".into());
    }
    match action {
        WindowAction::State => {}
        WindowAction::Minimize => window.minimize().map_err(|e| e.to_string())?,
        WindowAction::Maximize => {
            if window.is_maximized().map_err(|e| e.to_string())? {
                window.unmaximize()
            } else {
                window.maximize()
            }
            .map_err(|e| e.to_string())?;
        }
        WindowAction::Close => {
            let state = chrome_state(&window);
            window.close().map_err(|e| e.to_string())?;
            return Ok(state);
        }
        WindowAction::Drag => window.start_dragging().map_err(|e| e.to_string())?,
    }
    Ok(chrome_state(&window))
}
#[tauri::command]
async fn show_discord(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    local(&window)?;
    show(&app);
    window.close().map_err(|e| e.to_string())
}
#[tauri::command]
async fn open_settings(
    app: AppHandle,
    window: WebviewWindow,
    fallback: Option<bool>,
) -> Result<(), String> {
    either(&window)?;
    if fallback.unwrap_or(false) {
        settings_fallback(&app)
    } else {
        settings_window(&app)
    }
}
fn settings_window(app: &AppHandle) -> Result<(), String> {
    let integrated = app
        .state::<AppState>()
        .runtime
        .lock()
        .is_ok_and(|r| r.ready && !r.safe_mode);
    if integrated {
        if let Some(w) = app.get_webview_window("main") {
            show(app);
            return w
                .eval("window.kawaicord.openSettings()")
                .map_err(|e| e.to_string());
        }
    }
    settings_fallback(app)
}
fn settings_fallback(app: &AppHandle) -> Result<(), String> {
    if let Some(w) = app.get_webview_window("settings") {
        w.show().map_err(|e| e.to_string())?;
        return w.set_focus().map_err(|e| e.to_string());
    }
    tauri::WebviewWindowBuilder::new(app, "settings", WebviewUrl::App("index.html".into()))
        .title("Kawaicord Settings")
        .inner_size(720.0, 850.0)
        .min_inner_size(570.0, 560.0)
        .decorations(true)
        .on_navigation(|u| u.scheme() == "tauri" || u.host_str() == Some("tauri.localhost"))
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}
#[tauri::command]
async fn reload_discord(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    either(&window)?;
    let target = if trusted(&window) {
        window.label()
    } else {
        "main"
    };
    app.get_webview_window(target)
        .ok_or("Discord window is closed")?
        .reload()
        .map_err(|e| e.to_string())
}
#[tauri::command]
async fn restart_app(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    either(&window)?;
    config::save_json(
        &app.state::<AppState>().profile.join("safe-mode.json"),
        &false,
    )?;
    clean_exit(&app);
    app.restart()
}
#[tauri::command]
async fn restart_recovery(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    either(&window)?;
    config::save_json(
        &app.state::<AppState>().profile.join("safe-mode.json"),
        &true,
    )?;
    clean_exit(&app);
    app.restart()
}
#[tauri::command]
fn get_settings(
    app: AppHandle,
    window: WebviewWindow,
    state: State<AppState>,
) -> Result<serde_json::Value, String> {
    either(&window)?;
    Ok(
        serde_json::json!({"config":*state.config.lock().map_err(|e|e.to_string())?,"runtime":*state.runtime.lock().map_err(|e|e.to_string())?,"updater":updater::status(&app)}),
    )
}
fn activity_host(app: &AppHandle) -> activity_host::ActivityHost {
    let state = app.state::<AppState>();
    let renderer = app.clone();
    activity_host::ActivityHost::new(
        state.config.clone(),
        state.config_changed.clone(),
        move |event| {
            if let Some(window) = renderer.get_webview_window("main") {
                let _ = window.eval(format!("window.__kawaicordActivity?.({event})"));
            }
        },
    )
}
async fn configure_rpc(app: &AppHandle) {
    let state = app.state::<AppState>();
    let enabled = !state.smoke && state.config.lock().is_ok_and(|c| c.rich_presence);
    let mut services = state.services.lock().await;
    if enabled && services.is_none() {
        match rpc::Service::start(activity_host(app)).await {
            Ok(s) => *services = Some(s),
            Err(e) => state.log(&format!("Rich Presence unavailable: {e}")),
        }
    } else if !enabled {
        *services = None;
    }
}
#[tauri::command]
async fn save_config(
    app: AppHandle,
    window: WebviewWindow,
    state: State<'_, AppState>,
    config: Config,
) -> Result<Config, String> {
    either(&window)?;
    let old = state.config.lock().map_err(|e| e.to_string())?.clone();
    if old.start_at_login != config.start_at_login {
        let manager = app.autolaunch();
        if config.start_at_login {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(|e| e.to_string())?;
    }
    {
        let mut guard = state.config.lock().map_err(|e| e.to_string())?;
        config::save_json(&state.profile.join("config.json"), &config)?;
        *guard = config.clone();
    }
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_visible(config.tray_enabled);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(format!(
            "window.__kawaicordUpdateConfig?.({})",
            serde_json::to_string(&config).map_err(|e| e.to_string())?
        ));
    }
    state.config_changed.notify_one();
    configure_rpc(&app).await;
    Ok(config)
}
#[tauri::command]
async fn refresh_mods(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    either(&window)?;
    refresh(&app, true).await
}
async fn refresh(app: &AppHandle, force: bool) -> Result<(), String> {
    let state = app.state::<AppState>();
    if state.refreshing.swap(true, Ordering::AcqRel) {
        return Err("A mod refresh is already running".into());
    }
    let mod_ = state.config.lock().map_err(|e| e.to_string())?.active_mod;
    let result = bundles::refresh(&state.profile, mod_, force).await;
    state.refreshing.store(false, Ordering::Release);
    if let Err(e) = &result {
        state.log(&format!(
            "Mod refresh failed; keeping the bundled or cached copy: {e}"
        ));
    }
    result
}
#[tauri::command]
fn report_runtime(
    app: AppHandle,
    window: WebviewWindow,
    state: State<AppState>,
    status: RuntimeStatus,
) -> Result<(), String> {
    if !trusted(&window) {
        return Err("Untrusted renderer".into());
    }
    if window.label().starts_with("instance-") {
        state.log(&format!(
            "Instance {}: ready={} modules={}",
            window.label(),
            status.ready,
            status.modules
        ));
        if let Some(instance) = app
            .state::<instances::Instances>()
            .0
            .lock()
            .map_err(|e| e.to_string())?
            .get_mut(window.label())
        {
            instance.ready = status.ready;
        }
        return Ok(());
    }
    state.log(&format!(
        "Renderer: {} Shelter={} modules={} media={} display={} ready={}",
        status.active_mod.id(),
        status.shelter,
        status.modules,
        status.media,
        status.screen_sharing,
        status.ready
    ));
    config::save_json(&state.profile.join("runtime.json"), &status)?;
    *state.runtime.lock().map_err(|e| e.to_string())? = status.clone();
    if state.smoke {
        if std::env::args().any(|a| a == "--media-test") && status.ready {
            tauri::async_runtime::spawn(diagnostics::run_media(app.clone(), window.clone()));
            return Ok(());
        }
        if std::env::args().any(|a| a == "--integration-test") && status.ready {
            tauri::async_runtime::spawn(diagnostics::run(app.clone(), window.clone()));
            return Ok(());
        }
        if std::env::args().any(|a| a == "--background-test")
            && status.ready
            && status.background_elapsed.is_none()
        {
            let serialized = serde_json::to_string(&status).map_err(|e| e.to_string())?;
            window.eval(format!(r#"(()=>{{const start=performance.now();setTimeout(()=>{{const status={serialized};status.backgroundElapsed=Math.round(performance.now()-start);status.backgroundHidden=document.hidden;status.ready=!!window.shelter&&Object.keys(window.Vencord?.Webpack?.cache||{{}}).length>100;window.__TAURI_INTERNALS__.invoke('report_runtime',{{status}});}},370000);}})()"#)).map_err(|e|e.to_string())?;
            background(&window, true);
            window.hide().map_err(|e| e.to_string())?;
            return Ok(());
        }
        let code = if status.ready
            && status
                .background_elapsed
                .is_none_or(|elapsed| elapsed >= 370000 && status.background_hidden == Some(true))
        {
            0
        } else {
            1
        };
        clean_exit(&app);
        app.exit(code);
    } else if status.ready {
        rpc::replay(&activity_host(&app));
        if state.config.lock().is_ok_and(|c| c.auto_update_mods) {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = refresh(&app, false).await;
            });
        }
    }
    Ok(())
}
#[tauri::command]
fn set_unread(window: WebviewWindow, count: i64) -> Result<(), String> {
    if !trusted(&window) {
        return Err("Untrusted renderer".into());
    }
    window
        .set_badge_count(if count > 0 {
            Some(count.min(9999))
        } else {
            None
        })
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn notification_permission(
    app: AppHandle,
    window: WebviewWindow,
    request: bool,
) -> Result<String, String> {
    if !trusted(&window) {
        return Err("Untrusted renderer".into());
    }
    let permission = if request {
        app.notification().request_permission()
    } else {
        app.notification().permission_state()
    }
    .map_err(|e| e.to_string())?;
    Ok(format!("{permission:?}").to_lowercase())
}
#[tauri::command]
fn notify(
    app: AppHandle,
    window: WebviewWindow,
    state: State<AppState>,
    title: String,
    body: String,
    id: i32,
) -> Result<(), String> {
    if !trusted(&window) || !state.config.lock().is_ok_and(|c| c.notifications) {
        return Err("Notifications disabled".into());
    }
    if format!(
        "{:?}",
        app.notification()
            .permission_state()
            .map_err(|e| e.to_string())?
    ) != "Granted"
    {
        return Ok(());
    }
    app.notification()
        .builder()
        .id(id)
        .extra("window", window.label())
        .title(title.chars().take(160).collect::<String>())
        .body(body.chars().take(1000).collect::<String>())
        .show()
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn close_notification(app: AppHandle, window: WebviewWindow, id: i32) -> Result<(), String> {
    if !trusted(&window) {
        return Err("Untrusted renderer".into());
    }
    app.notification()
        .remove_active(vec![id])
        .map_err(|error| error.to_string())
}
#[tauri::command]
async fn check_update(app: AppHandle, window: WebviewWindow) -> Result<updater::Status, String> {
    either(&window)?;
    updater::check(&app).await
}
#[tauri::command]
async fn install_update(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    either(&window)?;
    updater::install(&app).await
}
#[tauri::command]
async fn open_releases(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    either(&window)?;
    app.opener()
        .open_url(
            "https://github.com/evenafterallisaid/kawaicord/releases",
            None::<&str>,
        )
        .map_err(|e| e.to_string())
}
fn open_external(app: &AppHandle, url: &url::Url) {
    if navigation::external(url) {
        let _ = app.opener().open_url(url.as_str(), None::<&str>);
    }
}
fn navigate_discord(window: &WebviewWindow, url: url::Url) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    window
        .with_webview(move |view| unsafe {
            use objc2::{msg_send, runtime::AnyObject};
            use objc2_foundation::{ns_string, NSNumber, NSBundle, NSString};
            let inner = view.inner() as *mut AnyObject;
            // wkwebview omits safari identification, which discord needs for voice support.
            let version = NSBundle::bundleWithPath(&NSString::from_str("/Applications/Safari.app"))
                .and_then(|bundle| bundle.objectForInfoDictionaryKey(ns_string!("CFBundleShortVersionString")))
                .and_then(|value| value.downcast::<NSString>().ok()).map(|value| value.to_string())
                .filter(|value| value.len() <= 32 && value.bytes().all(|byte| byte.is_ascii_digit() || byte == b'.'));
            if let Some(version) = version {
                let agent = NSString::from_str(&format!("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/{version} Safari/605.1.15"));
                let _: () = msg_send![inner, setCustomUserAgent:&*agent];
            }
            let configuration: *mut AnyObject = msg_send![inner, configuration];
            let _: () = msg_send![configuration, setMediaTypesRequiringUserActionForPlayback:0usize];
            let preferences: *mut AnyObject = msg_send![configuration, preferences];
            let yes = NSNumber::numberWithBool(true);
            let _: () =
                msg_send![preferences,setValue:&*yes,forKey:ns_string!("mediaDevicesEnabled")];
        })
        .map_err(|e| e.to_string())?;
    window.navigate(url).map_err(|e| e.to_string())
}
fn build_discord(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let state = app.state::<AppState>();
    let config = state.config.lock().unwrap().clone();
    let safe = state.runtime.lock().unwrap().safe_mode;
    let script = bundles::initialization(&state.profile, config.active_mod, safe, &config)?;
    let saved = state.window_state.lock().unwrap().clone();
    let (width, height) = saved.size();
    let nav_app = app.clone();
    let popup_app = app.clone();
    let mut builder = tauri::WebviewWindowBuilder::new(
        app,
        "main",
        WebviewUrl::External(
            if cfg!(target_os = "macos") {
                "about:blank"
            } else {
                "https://discord.com/app"
            }
            .parse()?,
        ),
    )
    .title("Kawaicord")
    .inner_size(width, height)
    .min_inner_size(800.0, 600.0)
    .decorations(cfg!(target_os = "macos"))
    .initialization_script(script)
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    .on_navigation(move |url| {
        let trusted = navigation::embedded(url);
        if !trusted {
            open_external(&nav_app, url)
        }
        trusted
    })
    .on_new_window(move |url, _| {
        open_external(&popup_app, &url);
        tauri::webview::NewWindowResponse::Deny
    })
    .on_permission_request(|view, _| {
        if view.url().is_ok_and(|u| {
            u.scheme() == "https"
                && u.host_str().is_some_and(|h| {
                    matches!(h, "discord.com" | "ptb.discord.com" | "canary.discord.com")
                })
        }) {
            tauri::webview::PermissionResponse::Default
        } else {
            tauri::webview::PermissionResponse::Deny
        }
    });
    if state.smoke {
        builder = builder.incognito(true);
    } else {
        builder = builder.data_directory(state.profile.join("webview"));
    }
    let window = builder.build()?;
    #[cfg(target_os = "macos")]
    navigate_discord(&window, "https://discord.com/app".parse()?)?;
    if saved.maximized {
        let _ = window.maximize();
    }
    let handle = app.clone();
    let events = window.clone();
    let previous_chrome = Mutex::new(None);
    window.on_window_event(move |event| {
        let state = handle.state::<AppState>();
        match event {
            WindowEvent::CloseRequested { api, .. } => {
                if !state.quitting.load(Ordering::Relaxed)
                    && state.config.lock().is_ok_and(|c| c.minimize_to_tray)
                {
                    api.prevent_close();
                    background(&events, true);
                    let _ = events.hide();
                } else {
                    clean_exit(&handle);
                    handle.exit(0);
                }
            }
            WindowEvent::Focused(_) => {
                let hidden =
                    !events.is_visible().unwrap_or(true) || events.is_minimized().unwrap_or(false);
                background(&events, hidden);
            }
            WindowEvent::Resized(_) if !events.is_minimized().unwrap_or(false) => {
                let maximized = events.is_maximized().unwrap_or(false);
                let mut saved = state.window_state.lock().unwrap();
                saved.maximized = maximized;
                if !maximized {
                    if let Ok(size) = events.inner_size() {
                        let scale = events.scale_factor().unwrap_or(1.0);
                        saved.width = f64::from(size.width) / scale;
                        saved.height = f64::from(size.height) / scale;
                    }
                }
            }
            _ => {}
        }
        if matches!(event, WindowEvent::Focused(_) | WindowEvent::Resized(_)) {
            report_window_state(&events, &previous_chrome);
        }
    });
    Ok(())
}
fn desktop(app: &AppHandle) -> tauri::Result<()> {
    let quit = tauri::menu::MenuItemBuilder::with_id("quit", "Quit Kawaicord")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let file = SubmenuBuilder::new(app, "Kawaicord")
        .about(None)
        .separator()
        .text("show", "Show Discord")
        .text("settings", "Settings…")
        .separator();
    #[cfg(target_os = "macos")]
    let file = file.hide().hide_others().separator();
    let file = file.item(&quit).build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .text("reload", "Reload Discord")
        .text("restart", "Restart Kawaicord");
    #[cfg(target_os = "macos")]
    let view = view.separator().minimize().maximize().fullscreen();
    let view = view.build()?;
    let menu = MenuBuilder::new(app)
        .items(&[&file, &edit, &view])
        .build()?;
    app.set_menu(menu)?;
    #[cfg(not(target_os = "macos"))]
    for window in app.webview_windows().values() {
        window.hide_menu()?;
    }
    let tray_menu = MenuBuilder::new(app)
        .text("show", "Open Kawaicord")
        .text("settings", "Settings…")
        .text("restart", "Restart Kawaicord")
        .separator()
        .text("quit", "Quit Kawaicord")
        .build()?;
    let icon = tauri::image::Image::from_bytes(include_bytes!("../../icons/tray-light.png"))?;
    let _ = tauri::tray::TrayIconBuilder::with_id("main")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Kawaicord")
        .menu(&tray_menu)
        .show_menu_on_left_click(true)
        .build(app);
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_visible(app.state::<AppState>().config.lock().unwrap().tray_enabled);
    }
    Ok(())
}
fn main() {
    env_logger::init();
    let builder = tauri::Builder::default();
    let builder = if std::env::args().any(|a| a == "--smoke-test") {
        builder
    } else {
        builder.plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
    };
    let builder = builder
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(updater::Updates::default())
        .manage(instances::Instances::default())
        .invoke_handler(tauri::generate_handler![
            cloud::cloud_request,
            instances::list_instances,
            instances::open_instance,
            instances::close_instance,
            instances::close_all_instances,
            instances::clear_instance_session,
            instances::report_instance_user,
            show_discord,
            open_settings,
            reload_discord,
            restart_app,
            restart_recovery,
            get_settings,
            save_config,
            refresh_mods,
            report_runtime,
            set_unread,
            notification_permission,
            notify,
            close_notification,
            check_update,
            install_update,
            open_releases,
            window_action
        ])
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => show(app),
            "settings" => {
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    let _ = settings_window(&app);
                });
            }
            "reload" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.reload();
                }
            }
            "restart" => {
                clean_exit(app);
                app.restart();
            }
            "quit" => {
                clean_exit(app);
                app.exit(0);
            }
            _ => {}
        })
        .setup(|app| {
            let smoke = std::env::args().any(|arg| arg == "--smoke-test");
            let profile = config::profile_override().unwrap_or(app.path().app_data_dir()?);
            fs::create_dir_all(&profile)?;
            let config = config::load_config(&profile.join("config.json"))?;
            let recovery: Recovery = config::read_json(&profile.join("recovery.json"));
            let requested: Option<bool> = fs::read(profile.join("safe-mode.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok());
            let _ = fs::remove_file(profile.join("safe-mode.json"));
            let safe = requested.unwrap_or_else(|| {
                (!smoke && recovery.recent_crash()) || std::env::args().any(|a| a == "--safe-mode")
            });
            let runtime = RuntimeStatus {
                active_mod: config.active_mod,
                safe_mode: safe,
                shelter: false,
                modules: 0,
                ready: false,
                media: false,
                screen_sharing: false,
                error: None,
                version: env!("CARGO_PKG_VERSION").into(),
                platform: std::env::consts::OS.into(),
                background_elapsed: None,
                background_hidden: None,
            };
            let window_state: WindowState = config::read_json(&profile.join("window.json"));
            app.manage(AppState {
                profile,
                window_state: Mutex::new(window_state),
                config: Arc::new(Mutex::new(config)),
                runtime: Mutex::new(runtime),
                quitting: AtomicBool::new(false),
                refreshing: AtomicBool::new(false),
                #[cfg(target_os = "macos")]
                renderer_crashes: std::sync::atomic::AtomicUsize::new(0),
                config_changed: Arc::new(tokio::sync::Notify::new()),
                services: tokio::sync::Mutex::new(None),
                smoke,
            });
            app.state::<AppState>().recovery(false);
            let notifications = app.handle().clone();
            app.notification().on_action(move |action| {
                if action.action_id() != "tap" {
                    return;
                }
                let notification = action.notification();
                let label = notification
                    .and_then(|item| item.extra().get("window"))
                    .and_then(|value| value.as_str())
                    .unwrap_or("main");
                if let Some(window) = notifications
                    .get_webview_window(label)
                    .or_else(|| notifications.get_webview_window("main"))
                {
                    let _ = window.show();
                    let _ = window.unminimize();
                    background(&window, false);
                    let _ = window.set_focus();
                    if let Some(notification) = notification {
                        let _ = window.eval(format!(
                            "window.__kawaicordNotificationClick?.({})",
                            notification.id()
                        ));
                    }
                }
            })?;
            build_discord(app.handle())?;
            desktop(app.handle())?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                configure_rpc(&handle).await;
            });
            if !smoke {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_secs(60)).await;
                    loop {
                        if handle
                            .state::<AppState>()
                            .config
                            .lock()
                            .is_ok_and(|c| c.auto_update_app)
                        {
                            if let Err(e) = updater::check(&handle).await {
                                handle
                                    .state::<AppState>()
                                    .log(&format!("Update check failed: {e}"));
                            }
                        }
                        tokio::time::sleep(std::time::Duration::from_secs(6 * 3600)).await;
                    }
                });
            }
            if smoke {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let timeout = if std::env::args().any(|a| a == "--background-test") {
                        430
                    } else if std::env::args().any(|a| a == "--integration-test") {
                        300
                    } else {
                        90
                    };
                    tokio::time::sleep(std::time::Duration::from_secs(timeout)).await;
                    handle.state::<AppState>().log("Smoke test timed out");
                    clean_exit(&handle);
                    handle.exit(2);
                });
            }
            Ok(())
        });
    #[cfg(target_os = "macos")]
    let builder = builder.on_web_content_process_terminate(|view| {
        if view.label() != "main" {
            return;
        }
        let app = view.app_handle();
        let state = app.state::<AppState>();
        let crashes = state.renderer_crashes.fetch_add(1, Ordering::Relaxed) + 1;
        state.log(&format!("Web content process terminated ({crashes})"));
        if crashes == 1 {
            let _ = view.reload();
        } else if crashes == 2 {
            if let Ok(mut runtime) = state.runtime.lock() {
                runtime.safe_mode = true;
                runtime.ready = false;
                runtime.error = Some(
                    "The webview crashed twice. Recovery mode has paused the client mod.".into(),
                );
            }
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.destroy();
            }
            if let Err(e) = build_discord(app) {
                state.log(&format!("Recovery failed: {e}"));
                let _ = settings_window(app);
            }
        } else {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.destroy();
            }
            let _ = settings_window(app);
        }
    });
    let app = builder
        .build(tauri::generate_context!())
        .expect("Unable to start Kawaicord");
    app.run(|app, event| match event {
        tauri::RunEvent::Exit => clean_exit(app),
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            if code.is_some() {
                clean_exit(app);
            } else if !app.state::<AppState>().quitting.load(Ordering::Relaxed) {
                api.prevent_exit();
            }
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show(app),
        _ => {}
    });
}
