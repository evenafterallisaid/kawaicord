use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WindowEvent};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct User {
    pub id: String,
    pub username: String,
    pub global_name: Option<String>,
    pub avatar_url: String,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Instance {
    pub id: String,
    pub name: String,
    pub domain: String,
    pub mode: String,
    pub save_session: bool,
    pub ready: bool,
    pub user: Option<User>,
}
#[derive(Default)]
pub struct Instances(pub Mutex<HashMap<String, Instance>>);
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn label(id: &str) -> Result<String, String> {
    if !valid_id(id) {
        return Err("Invalid instance id".into());
    }
    Ok(format!("instance-{}", id.to_ascii_lowercase()))
}
fn allowed_domain(domain: &str) -> bool {
    matches!(
        domain,
        "discord.com" | "ptb.discord.com" | "canary.discord.com"
    )
}
#[cfg(any(target_os = "macos", test))]
fn store_id(id: &str) -> [u8; 16] {
    // deterministic namespace separate from the primary account and other clients.
    let digest = sha2::Sha256::digest(format!("com.kawaicord.native/instances/{id}"));
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 15) | 0x50;
    bytes[8] = (bytes[8] & 63) | 0x80;
    bytes
}
#[cfg(any(target_os = "macos", test))]
use sha2::Digest;
fn profile(app: &AppHandle, id: &str) -> std::path::PathBuf {
    app.state::<super::AppState>()
        .profile
        .join("instances")
        .join(id.to_ascii_lowercase())
}
#[tauri::command]
pub fn list_instances(app: AppHandle, window: WebviewWindow) -> Result<Vec<Instance>, String> {
    super::either(&window)?;
    Ok(app
        .state::<Instances>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .values()
        .cloned()
        .collect())
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn open_instance(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    name: String,
    save_session: bool,
    domain: String,
    block_external_token_access: bool,
    performance_mode: bool,
    mode: String,
) -> Result<(), String> {
    super::either(&window)?;
    let label = label(&id)?;
    let id = id.to_ascii_lowercase();
    if !allowed_domain(&domain) {
        return Err("Unsupported Discord domain".into());
    }
    if !matches!(mode.as_str(), "detached" | "grouped") {
        return Err("Invalid instance mode".into());
    }
    #[cfg(not(target_os = "macos"))]
    if mode == "grouped" {
        return Err(
            "Use detached mode on this platform; grouped native tabs are available on macOS."
                .into(),
        );
    }
    if let Some(existing) = app.get_webview_window(&label) {
        existing.show().map_err(|e| e.to_string())?;
        return existing.set_focus().map_err(|e| e.to_string());
    }
    if app
        .state::<Instances>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .len()
        >= 8
    {
        return Err("Close an instance before opening more than eight.".into());
    }
    let persistent = save_session && !block_external_token_access;
    if block_external_token_access {
        #[cfg(target_os = "macos")]
        let can_clear = objc2_foundation::NSProcessInfo::processInfo()
            .operatingSystemVersion()
            .majorVersion
            >= 14;
        #[cfg(not(target_os = "macos"))]
        let can_clear = true;
        if can_clear {
            clear_instance_session(app.clone(), window.clone(), id.clone()).await?;
        }
    }
    #[cfg(target_os = "macos")]
    {
        use objc2_foundation::NSProcessInfo;
        let version = NSProcessInfo::processInfo().operatingSystemVersion();
        if version.majorVersion < 14 && persistent {
            return Err("Saved isolated instances require macOS 14 or newer. Turn off Save session to use a temporary session.".into());
        }
    }
    let mut config = app
        .state::<super::AppState>()
        .config
        .lock()
        .map_err(|e| e.to_string())?
        .clone();
    config.performance_mode = performance_mode;
    config.rich_presence = false;
    let script =
        super::bundles::initialization(&profile(&app, &id), config.active_mod, false, &config)
            .map_err(|e| e.to_string())?;
    let nav_app = app.clone();
    let popup_app = app.clone();
    let title = if name.trim().is_empty() {
        "Discord instance".to_owned()
    } else {
        name.chars().take(80).collect::<String>()
    };
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .title(format!("{title} | Kawaicord"))
    .inner_size(1100.0, 800.0)
    .min_inner_size(800.0, 600.0)
    .decorations(true)
    .initialization_script(script)
    .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
    .on_navigation(move |u| {
        let allowed = super::navigation::embedded(u);
        if !allowed {
            super::open_external(&nav_app, u)
        }
        allowed
    })
    .on_new_window(move |u, _| {
        super::open_external(&popup_app, &u);
        tauri::webview::NewWindowResponse::Deny
    })
    .on_permission_request(|view, _| {
        if view
            .url()
            .is_ok_and(|u| u.scheme() == "https" && u.host_str().is_some_and(allowed_domain))
        {
            tauri::webview::PermissionResponse::Default
        } else {
            tauri::webview::PermissionResponse::Deny
        }
    });
    if persistent {
        #[cfg(target_os = "macos")]
        {
            builder = builder.data_store_identifier(store_id(&id));
        }
        #[cfg(not(target_os = "macos"))]
        {
            let data = profile(&app, &id).join("webview");
            std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
            builder = builder.data_directory(data);
        }
    } else {
        #[cfg(not(target_os = "macos"))]
        {
            let data = profile(&app, &id).join("temporary-webview");
            std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
            builder = builder.data_directory(data);
        }
        builder = builder.incognito(true);
    }
    #[cfg(target_os = "macos")]
    if mode == "grouped" {
        builder = builder.tabbing_identifier("kawaicord-accounts");
    }
    let instance = builder.build().map_err(|e| e.to_string())?;
    super::navigate_discord(&instance, format!("https://{domain}/app").parse().unwrap())?;
    app.state::<Instances>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .insert(
            label.clone(),
            Instance {
                id,
                name: title,
                domain,
                mode: mode.clone(),
                save_session: persistent,
                ready: false,
                user: None,
            },
        );
    #[cfg(target_os = "macos")]
    if mode == "grouped" {
        let new_window = instance.clone();
        let handle = app.clone();
        app.run_on_main_thread(move || {
            if let Some(main) = handle.get_webview_window("main") {
                if let (Ok(main_ptr), Ok(new_ptr)) = (main.ns_window(), new_window.ns_window()) {
                    unsafe {
                        use objc2::{msg_send, runtime::AnyObject};
                        let parent = main_ptr as *mut AnyObject;
                        let child = new_ptr as *mut AnyObject;
                        let _: () = msg_send![parent,addTabbedWindow:child,ordered:1isize];
                    }
                }
            }
        })
        .map_err(|e| e.to_string())?;
    }
    let handle = app.clone();
    let events = instance.clone();
    instance.on_window_event(move |event| match event {
        WindowEvent::Destroyed => {
            if let Ok(mut instances) = handle.state::<Instances>().0.lock() {
                instances.remove(&label);
            }
        }
        WindowEvent::Focused(_) => super::background(
            &events,
            !events.is_visible().unwrap_or(true) || events.is_minimized().unwrap_or(false),
        ),
        _ => {}
    });
    Ok(())
}
#[tauri::command]
pub async fn close_instance(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<(), String> {
    super::either(&window)?;
    let label = label(&id)?;
    if let Some(w) = app.get_webview_window(&label) {
        w.destroy().map_err(|e| e.to_string())?
    }
    wait_closed(&app, &[label]).await
}
#[tauri::command]
pub async fn close_all_instances(app: AppHandle, window: WebviewWindow) -> Result<(), String> {
    super::either(&window)?;
    let mut labels = Vec::new();
    for (label, w) in app.webview_windows() {
        if label.starts_with("instance-") {
            w.destroy().map_err(|e| e.to_string())?;
            labels.push(label);
        }
    }
    wait_closed(&app, &labels).await
}
async fn wait_closed(app: &AppHandle, labels: &[String]) -> Result<(), String> {
    for _ in 0..50 {
        if labels
            .iter()
            .all(|label| app.get_webview_window(label).is_none())
        {
            return Ok(());
        }
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }
    Err("The instance is still closing. Try again in a moment.".into())
}
#[tauri::command]
pub async fn clear_instance_session(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
) -> Result<(), String> {
    super::either(&window)?;
    let label = label(&id)?;
    if app.get_webview_window(&label).is_some() {
        return Err("Close the instance before clearing its saved session.".into());
    }
    #[cfg(target_os = "macos")]
    if objc2_foundation::NSProcessInfo::processInfo()
        .operatingSystemVersion()
        .majorVersion
        < 14
    {
        return Err("Saved isolated instances require macOS 14 or newer.".into());
    }
    let builder = tauri::WebviewWindowBuilder::new(
        &app,
        format!("clear-{label}"),
        WebviewUrl::External("about:blank".parse().unwrap()),
    )
    .visible(false);
    #[cfg(target_os = "macos")]
    let builder = builder.data_store_identifier(store_id(&id.to_ascii_lowercase()));
    #[cfg(not(target_os = "macos"))]
    let builder = {
        let data = profile(&app, &id).join("webview");
        std::fs::create_dir_all(&data).map_err(|e| e.to_string())?;
        builder.data_directory(data)
    };
    let temporary = builder.build().map_err(|e| e.to_string())?;
    // the engine owns both cached and saved login data, including after windows close.
    let cleared = clear_native_store(&temporary).await;
    let destroyed = temporary.destroy().map_err(|e| e.to_string());
    cleared?;
    destroyed?;
    wait_closed(&app, &[format!("clear-{label}")]).await
}

async fn clear_native_store(window: &WebviewWindow) -> Result<(), String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(), String>>();
    window.with_webview(move |view| {
        #[cfg(target_os = "macos")]
        unsafe {
            use objc2::{class, msg_send, runtime::AnyObject};
            use objc2_foundation::NSDate;
            let inner = view.inner() as *mut AnyObject;
            let config: *mut AnyObject = msg_send![inner, configuration];
            let store: *mut AnyObject = msg_send![config, websiteDataStore];
            let types: *mut AnyObject = msg_send![class!(WKWebsiteDataStore), allWebsiteDataTypes];
            let date = NSDate::dateWithTimeIntervalSince1970(0.0);
            let sender = std::sync::Mutex::new(Some(tx));
            let callback = block2::RcBlock::new(move || {
                if let Some(tx) = sender.lock().unwrap().take() { let _ = tx.send(Ok(())); }
            });
            let _: () = msg_send![store, removeDataOfTypes:types, modifiedSince:&*date, completionHandler:&*callback];
        }
        #[cfg(target_os = "windows")]
        unsafe {
            use webview2_com::{ClearBrowsingDataCompletedHandler, Microsoft::Web::WebView2::Win32::{ICoreWebView2_13, ICoreWebView2Profile2}};
            use windows::core::Interface;
            let sender = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));
            let completion = sender.clone();
            let result: windows::core::Result<()> = (|| {
                view.controller().CoreWebView2()?.cast::<ICoreWebView2_13>()?.Profile()?.cast::<ICoreWebView2Profile2>()?
                    .ClearBrowsingDataAll(&ClearBrowsingDataCompletedHandler::create(Box::new(move |result| {
                        if let Some(tx) = completion.lock().unwrap().take() { let _ = tx.send(result.map_err(|error|error.to_string())); }
                        Ok(())
                    })))
            })();
            if let Err(error) = result {
                if let Some(tx) = sender.lock().unwrap().take() { let _ = tx.send(Err(error.to_string())); }
            }
        }
        #[cfg(target_os = "linux")]
        {
            use webkit2gtk::{WebContextExt, WebViewExt, WebsiteDataManagerExtManual, WebsiteDataTypes};
            let manager = view.inner().context().and_then(|context| context.website_data_manager());
            if let Some(manager) = manager {
                manager.clear(WebsiteDataTypes::ALL, gtk::glib::TimeSpan::from_seconds(0), None::<&gtk::gio::Cancellable>, move |result| {
                    let _ = tx.send(result.map_err(|error|error.to_string()));
                });
            } else { let _ = tx.send(Err("Instance storage manager unavailable".into())); }
        }
    }).map_err(|e|e.to_string())?;
    tokio::time::timeout(std::time::Duration::from_secs(30), rx)
        .await
        .map_err(|_| "Clearing the instance session timed out".to_owned())?
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn report_instance_user(
    app: AppHandle,
    window: WebviewWindow,
    user: Option<User>,
) -> Result<(), String> {
    super::either(&window)?;
    if let Some(user) = &user {
        if user.id.len() > 32
            || user.username.len() > 128
            || user.avatar_url.len() > 2048
            || user.global_name.as_ref().is_some_and(|n| n.len() > 128)
        {
            return Err("Invalid instance account metadata".into());
        }
    }
    if let Some(instance) = app
        .state::<Instances>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get_mut(window.label())
    {
        instance.user = user;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn instance_identifiers_cannot_escape_the_profile() {
        for id in ["../main", "a/b", "", "a\\b"] {
            assert!(label(id).is_err())
        }
        assert_eq!(label("Secondary").unwrap(), "instance-secondary");
    }
    #[test]
    fn cookie_stores_are_stable_and_separate() {
        assert_eq!(store_id("secondary"), store_id("secondary"));
        assert_ne!(store_id("secondary"), store_id("third"));
    }
}
