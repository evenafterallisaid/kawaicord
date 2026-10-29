use serde::{Deserialize, Serialize};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
#[derive(Default)]
pub struct Updates {
    candidate: Mutex<Option<Update>>,
    busy: AtomicBool,
    status: Mutex<Option<Status>>,
}
struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
fn acquire(updates: &Updates) -> Result<Operation<'_>, String> {
    if updates.busy.swap(true, Ordering::AcqRel) {
        return Err("An update operation is already running.".into());
    }
    Ok(Operation(&updates.busy))
}
#[derive(Clone, Serialize)]
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
    tag_name: String,
}
pub fn status(app: &AppHandle) -> Status {
    app.state::<Updates>()
        .status
        .lock()
        .ok()
        .and_then(|value| value.clone())
        .unwrap_or(Status {
            available: false,
            message: "No update check has run yet.".into(),
        })
}
pub async fn check(app: &AppHandle) -> Result<Status, String> {
    let state = app.state::<Updates>();
    let _operation = acquire(&state)?;
    let result = check_inner(app).await;
    let status = result.clone().unwrap_or_else(|error| Status {
        available: false,
        message: error,
    });
    *state.status.lock().map_err(|error| error.to_string())? = Some(status);
    result
}
async fn check_inner(app: &AppHandle) -> Result<Status, String> {
    let state = app.state::<Updates>();
    *state.candidate.lock().map_err(|error| error.to_string())? = None;
    #[cfg(target_os = "linux")]
    if std::env::var_os("APPIMAGE").is_none() {
        return Ok(Status {
            available: false,
            message:
                "Download the latest Linux installer from Releases to update this installation."
                    .into(),
        });
    }
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
    let allow_preview = app
        .state::<super::AppState>()
        .config
        .lock()
        .map_err(|error| error.to_string())?
        .preview_updates;
    let manifest = select_manifest(&releases, allow_preview);
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
        .timeout(Duration::from_secs(120))
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
    *state.candidate.lock().map_err(|e| e.to_string())? = update;
    Ok(status)
}
fn select_manifest(releases: &[Release], allow_preview: bool) -> Option<&Asset> {
    releases
        .iter()
        .filter(|release| !release.draft && (allow_preview || !release.prerelease))
        .filter_map(|release| {
            let version = semver::Version::parse(release.tag_name.trim_start_matches('v')).ok()?;
            if !allow_preview && !version.pre.is_empty() {
                return None;
            }
            Some((
                version,
                release
                    .assets
                    .iter()
                    .find(|asset| asset.name == "latest.json")?,
            ))
        })
        .max_by(|(a, _), (b, _)| a.cmp(b))
        .map(|(_, asset)| asset)
}
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<Updates>();
    let _operation = acquire(&state)?;
    let update = state
        .candidate
        .lock()
        .map_err(|e| e.to_string())?
        .take()
        .ok_or("Check for an update first")?;
    let result = update.download_and_install(|_, _| {}, || {}).await;
    if let Err(error) = result {
        *state.candidate.lock().map_err(|e| e.to_string())? = Some(update);
        return Err(format!(
            "Update failed: {error}. You can retry or download the installer from Releases."
        ));
    }
    super::clean_exit(app);
    app.restart();
}
#[cfg(test)]
mod tests {
    use super::*;
    fn release(version: &str, preview: bool) -> Release {
        Release {
            tag_name: version.into(),
            draft: false,
            prerelease: preview,
            assets: vec![Asset {
                name: "latest.json".into(),
                browser_download_url: version.into(),
            }],
        }
    }
    #[test]
    fn selects_versions_instead_of_publication_order() {
        let releases = vec![
            release("v2.1.0", false),
            release("v2.3.0", false),
            release("v2.2.0", false),
        ];
        assert_eq!(
            select_manifest(&releases, false)
                .unwrap()
                .browser_download_url,
            "v2.3.0"
        );
    }
    #[test]
    fn previews_require_opt_in_and_drafts_are_ignored() {
        let mut draft = release("v9.0.0", false);
        draft.draft = true;
        let releases = vec![
            draft,
            release("v3.0.0-beta.1", true),
            release("v2.0.0", false),
        ];
        assert_eq!(
            select_manifest(&releases, false)
                .unwrap()
                .browser_download_url,
            "v2.0.0"
        );
        assert_eq!(
            select_manifest(&releases, true)
                .unwrap()
                .browser_download_url,
            "v3.0.0-beta.1"
        );
    }
    #[test]
    fn failed_operation_releases_the_lock() {
        let updates = Updates::default();
        let first = acquire(&updates).unwrap();
        assert!(acquire(&updates).is_err());
        drop(first);
        assert!(acquire(&updates).is_ok());
    }
}
