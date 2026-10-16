use serde::{Deserialize, Serialize};
use std::{sync::Mutex, time::Duration};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
#[derive(Default)]
pub struct Updates(pub Mutex<Option<Update>>);
#[derive(Serialize)]
pub struct Status {
    pub available: bool,
    pub message: String,
}
#[derive(Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
}
#[derive(Deserialize)]
struct Release {
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}
pub async fn check(app: &AppHandle) -> Result<Status, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("Kawaicord/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let releases: Vec<Release> = client
        .get("https://api.github.com/repos/evenafterallisaid/kawaicord/releases?per_page=20")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let allow_preview = env!("CARGO_PKG_VERSION").contains('-');
    let manifest = releases
        .iter()
        .filter(|r| !r.draft && (!r.prerelease || allow_preview))
        .flat_map(|r| &r.assets)
        .find(|a| a.name == "latest.json");
    let Some(manifest) = manifest else {
        return Ok(Status {
            available: false,
            message: "No newer native release is published yet.".into(),
        });
    };
    let url = url::Url::parse(&manifest.browser_download_url).map_err(|e| e.to_string())?;
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || !url
            .path()
            .starts_with("/evenafterallisaid/kawaicord/releases/download/")
    {
        return Err("Unexpected updater manifest origin".into());
    }
    let update = app
        .updater_builder()
        .endpoints(vec![url])
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;
    let status = match &update {
        Some(u) => Status {
            available: true,
            message: format!(
                "Version {} is available. Choose Install update and restart when ready.",
                u.version
            ),
        },
        None => Status {
            available: false,
            message: "You're using the latest native release.".into(),
        },
    };
    *app.state::<Updates>().0.lock().map_err(|e| e.to_string())? = update;
    Ok(status)
}
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let update = app
        .state::<Updates>()
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("Check for an update first")?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| e.to_string())?;
    super::clean_exit(app);
    app.restart();
}
