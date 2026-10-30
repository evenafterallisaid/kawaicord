use base64::Engine;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tokio::io::AsyncWriteExt;

#[derive(Clone, Serialize)]
pub struct Status {
    pub available: bool,
    pub message: String,
}
impl Default for Status {
    fn default() -> Self {
        Self {
            available: false,
            message: "No update check has run yet.".into(),
        }
    }
}
#[derive(Clone, Deserialize)]
struct Payload {
    url: String,
    signature: String,
}
#[derive(Deserialize)]
struct Manifest {
    version: String,
    platforms: HashMap<String, Payload>,
}
#[derive(Clone)]
struct Candidate {
    version: String,
    payload: Payload,
}
#[derive(Default)]
pub struct Updater {
    candidate: Mutex<Option<Candidate>>,
    last: Mutex<Status>,
    busy: AtomicBool,
}
struct Operation<'a>(&'a AtomicBool);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
impl Updater {
    pub fn status(&self) -> Status {
        self.last.lock().unwrap().clone()
    }
    fn acquire(&self) -> Result<Operation<'_>, String> {
        if self.busy.swap(true, Ordering::AcqRel) {
            return Err("An update operation is already running.".into());
        }
        Ok(Operation(&self.busy))
    }
    pub async fn check(&self, preview: bool) -> Result<Status, String> {
        let _operation = self.acquire()?;
        *self.candidate.lock().unwrap() = None;
        let result = self.check_inner(preview).await;
        *self.last.lock().unwrap() = result.clone().unwrap_or_else(|error| Status {
            available: false,
            message: error,
        });
        result
    }
    async fn check_inner(&self, preview: bool) -> Result<Status, String> {
        if std::env::var_os("APPIMAGE").is_none() {
            return Ok(Status {
                available: false,
                message:
                    "Download the latest Linux installer from Releases to update this installation."
                        .into(),
            });
        }
        let client = client()?;
        let releases: Vec<crate::release_feed::Release> = client
            .get("https://api.github.com/repos/evenafterallisaid/kawaicord/releases?per_page=20")
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?
            .json()
            .await
            .map_err(|error| error.to_string())?;
        let Some(asset) = crate::release_feed::select_manifest(&releases, preview) else {
            return Ok(Status {
                available: false,
                message: "No newer Linux release is published yet.".into(),
            });
        };
        if !trusted(&asset.browser_download_url) {
            return Err("Unexpected updater manifest origin".into());
        }
        let manifest: Manifest = client
            .get(&asset.browser_download_url)
            .timeout(Duration::from_secs(20))
            .send()
            .await
            .map_err(|error| error.to_string())?
            .error_for_status()
            .map_err(|error| error.to_string())?
            .json()
            .await
            .map_err(|error| error.to_string())?;
        let version = semver::Version::parse(manifest.version.trim_start_matches('v'))
            .map_err(|error| error.to_string())?;
        let current =
            semver::Version::parse(env!("CARGO_PKG_VERSION")).map_err(|error| error.to_string())?;
        if version <= current || (!preview && !version.pre.is_empty()) {
            return Ok(Status {
                available: false,
                message: "You're using the latest Linux release.".into(),
            });
        }
        let payload = manifest
            .platforms
            .get("linux-x86_64")
            .ok_or("This release has no compatible Linux updater payload.")?
            .clone();
        if !trusted(&payload.url) || payload.signature.len() > 16384 {
            return Err("Unexpected Linux updater payload".into());
        }
        *self.candidate.lock().unwrap() = Some(Candidate {
            version: version.to_string(),
            payload,
        });
        Ok(Status {
            available: true,
            message: format!("Version {version} is available. Install and restart when ready."),
        })
    }
    pub async fn install(&self, profile: &Path, preview: bool) -> Result<(), String> {
        let _operation = self.acquire()?;
        let candidate = self
            .candidate
            .lock()
            .unwrap()
            .clone()
            .ok_or("Check for an update first")?;
        let version =
            semver::Version::parse(&candidate.version).map_err(|error| error.to_string())?;
        if !preview && !version.pre.is_empty() {
            return Err("Preview updates are disabled. Check for a stable update.".into());
        }
        let appimage = std::env::var_os("APPIMAGE")
            .ok_or("Use the downloaded Linux installer to update this installation.")?;
        let installed = std::fs::canonicalize(appimage).map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            let metadata = std::fs::metadata(&installed).map_err(|error| error.to_string())?;
            if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } {
                return Err(
                    "Download the installer to update an installation owned by another user."
                        .into(),
                );
            }
        }
        let parent = installed.parent().ok_or("Missing application directory")?;
        let suffix = format!("{}-{}", std::process::id(), crate::config::now());
        let temporary = parent.join(format!(".kawaicord-update-{suffix}.tmp"));
        let backup = parent.join(format!(".kawaicord-previous-{suffix}.AppImage"));
        let mut created = false;
        let result = async {
            let config: serde_json::Value =
                serde_json::from_str(include_str!("../tauri.conf.json"))
                    .map_err(|error| error.to_string())?;
            let public = decode(
                config["plugins"]["updater"]["pubkey"]
                    .as_str()
                    .ok_or("Missing update public key")?,
            )?;
            let key =
                minisign_verify::PublicKey::decode(&public).map_err(|error| error.to_string())?;
            let signature_text = decode(&candidate.payload.signature)?;
            let signature = minisign_verify::Signature::decode(&signature_text)
                .map_err(|error| error.to_string())?;
            let mut verifier = key
                .verify_stream(&signature)
                .map_err(|error| error.to_string())?;
            let mut response = client()?
                .get(&candidate.payload.url)
                .header("Accept", "application/octet-stream")
                .timeout(Duration::from_secs(900))
                .send()
                .await
                .map_err(|error| error.to_string())?
                .error_for_status()
                .map_err(|error| error.to_string())?;
            let mut file = tokio::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .await
                .map_err(|error| error.to_string())?;
            created = true;
            let mut total = 0usize;
            while let Some(chunk) = response.chunk().await.map_err(|error| error.to_string())? {
                total += chunk.len();
                if total > 512 * 1024 * 1024 {
                    return Err("Update payload exceeds its size limit".into());
                }
                verifier.update(&chunk);
                file.write_all(&chunk)
                    .await
                    .map_err(|error| error.to_string())?;
            }
            verifier
                .finalize()
                .map_err(|error| format!("Update signature verification failed: {error}"))?;
            signed_version(signature.trusted_comment(), &candidate.version)?;
            file.sync_all().await.map_err(|error| error.to_string())?;
            drop(file);
            let header = std::fs::File::open(&temporary)
                .and_then(|mut file| {
                    use std::io::Read;
                    let mut bytes = [0u8; 12];
                    file.read_exact(&mut bytes)?;
                    Ok(bytes)
                })
                .map_err(|error| error.to_string())?;
            if &header[..4] != b"\x7fELF" || &header[8..11] != b"AI\x02" {
                return Err("The signed payload is not a supported AppImage".into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                std::fs::set_permissions(&temporary, std::fs::Permissions::from_mode(0o755))
                    .map_err(|error| error.to_string())?;
            }
            crate::config::save_json(&profile.join("update-backup.json"), &backup)?;
            std::fs::rename(&installed, &backup).map_err(|error| error.to_string())?;
            if let Err(error) = std::fs::rename(&temporary, &installed) {
                let _ = std::fs::rename(&backup, &installed);
                return Err(error.to_string());
            }
            Ok(())
        }
        .await;
        if result.is_err() && created {
            let _ = std::fs::remove_file(&temporary);
        }
        result
    }
}
fn decode(value: &str) -> Result<String, String> {
    String::from_utf8(
        base64::engine::general_purpose::STANDARD
            .decode(value)
            .map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}
fn trusted(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.port_or_known_default() == Some(443)
            && ((url.host_str() == Some("github.com")
                && url
                    .path()
                    .starts_with("/evenafterallisaid/kawaicord/releases/download/"))
                || (url.host_str() == Some("api.github.com")
                    && url
                        .path()
                        .starts_with("/repos/evenafterallisaid/kawaicord/releases/assets/")))
    })
}
fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(concat!("Kawaicord/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| error.to_string())
}
fn signed_version(comment: &str, version: &str) -> Result<(), String> {
    let signed = comment
        .split('\t')
        .find_map(|field| field.strip_prefix("version:"))
        .ok_or("The updater signature has no signed version")?;
    let signed = semver::Version::parse(signed.trim_start_matches('v'))
        .map_err(|_| "The updater signature has an invalid version")?;
    let announced = semver::Version::parse(version.trim_start_matches('v'))
        .map_err(|_| "The updater manifest has an invalid version")?;
    if signed != announced {
        return Err("The signed update version does not match the manifest".into());
    }
    Ok(())
}
pub fn cleanup_backup(profile: &Path) {
    let Some(appimage) = std::env::var_os("APPIMAGE") else {
        return;
    };
    let Ok(installed) = std::fs::canonicalize(appimage) else {
        return;
    };
    let Ok(path) = std::fs::read_to_string(profile.join("update-backup.json"))
        .ok()
        .and_then(|value| serde_json::from_str::<std::path::PathBuf>(&value).ok())
        .ok_or(())
    else {
        return;
    };
    if path.parent() == installed.parent()
        && path
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(".kawaicord-previous-"))
    {
        let _ = std::fs::remove_file(path);
        let _ = std::fs::remove_file(profile.join("update-backup.json"));
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn update_payloads_stay_on_the_project_release_origins() {
        assert!(trusted(
            "https://github.com/evenafterallisaid/kawaicord/releases/download/v2.0.1/app.AppImage"
        ));
        assert!(trusted(
            "https://api.github.com/repos/evenafterallisaid/kawaicord/releases/assets/123"
        ));
        for value in [
            "https://github.com/other/repo/releases/download/v1/app.AppImage",
            "https://github.com.evil.test/evenafterallisaid/kawaicord/releases/download/x",
            "http://github.com/evenafterallisaid/kawaicord/releases/download/x",
        ] {
            assert!(!trusted(value));
        }
    }
    #[test]
    fn update_signatures_must_name_the_announced_version() {
        assert!(signed_version("timestamp:1\tfile:app\tversion:2.0.1", "2.0.1").is_ok());
        assert!(signed_version("timestamp:1\tfile:app\tversion:2.0.0", "2.0.1").is_err());
        assert!(signed_version("timestamp:1\tfile:app", "2.0.1").is_err());
    }
}
