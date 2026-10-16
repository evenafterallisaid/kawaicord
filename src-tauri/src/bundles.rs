use crate::config::{self, ClientMod};
use base64::Engine;
use regex::Regex;
use serde::{Deserialize, Serialize};
use std::{fs, path::Path, sync::OnceLock, time::Duration};

const SHELTER: &str = include_str!("../../shelter/shelter.js");
const VENCORD: &str = include_str!("../../vencord/vencord.js");
const VENCORD_CSS: &str = include_str!("../../vencord/vencord.css");
const EQUICORD: &str = include_str!("../../equicord/equicord.js");
const EQUICORD_CSS: &str = include_str!("../../equicord/equicord.css");

#[derive(Serialize, Deserialize, Default)]
struct CacheManifest {
    updated_at: u64,
    #[serde(default)]
    generation: String,
}
pub fn plausible(content: &str, css: bool) -> bool {
    let prefix = content.chars().take(512).collect::<String>().to_lowercase();
    content.len() >= if css { 256 } else { 1024 }
        && content.len() < 16 * 1024 * 1024
        && !prefix.contains("<!doctype html")
        && !prefix.contains("<html")
}
pub fn patch_bundle(source: &str) -> String {
    const BROKEN_LOGO: &str =
        "https://github.com/ImHisako/ImHisako/blob/main/Images/Illegalcord.png?raw=true";
    let mut patched = patch_restarts(source).replacen(
        "pluginHelpers:{}",
        "pluginHelpers:(window.__kawaicordPluginHelpers??{})",
        1,
    );
    let icons: std::collections::HashMap<String, String> =
        serde_json::from_str(include_str!("../../native-data/mod-icons.json")).unwrap();
    for (url, data) in icons {
        patched = patched.replace(&url, &data);
    }
    if !patched.contains(BROKEN_LOGO) {
        return patched;
    }
    let logo = format!(
        "data:image/png;base64,{}",
        base64::engine::general_purpose::STANDARD
            .encode(include_bytes!("../../native-data/illegalcord.png"))
    );
    format!(
        "window.__kawaicordIllegalcordLogo={};{}",
        serde_json::to_string(&logo).unwrap(),
        patched.replace(
            &format!("\"{BROKEN_LOGO}\""),
            "window.__kawaicordIllegalcordLogo"
        )
    )
}
pub fn patch_restarts(source: &str) -> String {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(?m)(^|[^\w$.])(?:(?:window|globalThis|document)\s*\.\s*)?location\s*\.\s*reload\s*\(\s*(?:true|false)?\s*\)").unwrap())
        .replace_all(source, "${1}window.kawaicord.restart()").into_owned()
}
pub fn source(mod_: ClientMod) -> (&'static str, &'static str) {
    match mod_ {
        ClientMod::Vencord => (VENCORD, VENCORD_CSS),
        ClientMod::Equicord => (EQUICORD, EQUICORD_CSS),
        ClientMod::Illegalcord => (
            include_str!("../../illegalcord/illegalcord.js"),
            include_str!("../../illegalcord/illegalcord.css"),
        ),
    }
}
fn read_cache(path: &Path, css: bool) -> Option<String> {
    fs::read_to_string(path).ok().filter(|v| plausible(v, css))
}
pub fn initialization(
    profile: &Path,
    mod_: ClientMod,
    safe: bool,
    config: &crate::config::Config,
) -> Result<String, String> {
    let dir = profile.join("bundles").join(mod_.id());
    // a cache pair is committed together. incomplete downloads never mask the installer fallback.
    let manifest: CacheManifest = config::read_json(&dir.join("manifest.json"));
    let valid = !manifest.generation.is_empty()
        && manifest
            .generation
            .bytes()
            .all(|b| b.is_ascii_digit() || b == b'-');
    let generation = dir.join(&manifest.generation);
    let cached = if valid {
        read_cache(&generation.join("browser.js"), false)
            .zip(read_cache(&generation.join("browser.css"), true))
    } else {
        None
    };
    let (js, css) = cached.unwrap_or_else(|| {
        let (j, c) = source(mod_);
        (j.to_owned(), c.to_owned())
    });
    let shelter = read_cache(&profile.join("bundles/shelter.js"), false)
        .unwrap_or_else(|| SHELTER.to_owned());
    let bootstrap = include_str!("../../web-dist/bootstrap.js");
    let settings = r#"const SHELTER_INJECTOR_PLUGINS={};const SHELTER_INJECTOR_SETTINGS=[['divider'],['header','Kawaicord'],['section','kawaicord','Settings',()=>window.__kawaicordSettingsPage()]];"#;
    let runtime = serde_json::json!({"activeMod":mod_, "safeMode":safe, "config":config,"version":env!("CARGO_PKG_VERSION"),"platform":std::env::consts::OS});
    // user scripts execute at document start in the page's main world. the mod
    // remains at global scope; no eval, network fetch, or async ipc races it.
    let origin_guard = "if(['https://discord.com','https://ptb.discord.com','https://canary.discord.com'].includes(location.origin)&&window===window.top){\n";
    Ok(format!("{origin_guard}window.__KAWAICORD_BOOT__={runtime};\n{bootstrap}\n(()=>{{{settings}\n{shelter}\n}})();\n{}\nwindow.__kawaicordNativeStart?.({});\n}}", if safe {String::new()} else {format!("{}\n;globalThis.Vencord=Vencord;",patch_bundle(&js))}, serde_json::to_string(&css).map_err(|e|e.to_string())?))
}
async fn download(client: &reqwest::Client, url: &str, css: bool) -> Result<String, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if bytes.len() + chunk.len() > 16 * 1024 * 1024 {
            return Err("Bundle exceeds size limit".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    let text = String::from_utf8(bytes).map_err(|e| e.to_string())?;
    if !plausible(&text, css) {
        return Err("Invalid browser bundle".into());
    }
    Ok(text)
}
pub async fn refresh(profile: &Path, mod_: ClientMod, force: bool) -> Result<(), String> {
    let dir = profile.join("bundles").join(mod_.id());
    let manifest: CacheManifest = config::read_json(&dir.join("manifest.json"));
    if !force && config::now().saturating_sub(manifest.updated_at) < 6 * 3600 {
        return Ok(());
    }
    let base = match mod_ {
        ClientMod::Vencord => "https://github.com/Vendicated/Vencord/releases/download/devbuild",
        ClientMod::Equicord => "https://github.com/Equicord/Equicord/releases/download/latest",
        ClientMod::Illegalcord => {
            "https://github.com/ImHisako/Illegalcord/releases/latest/download"
        }
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent(concat!("Kawaicord/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())?;
    let js_url = format!("{base}/browser.js");
    let css_url = format!("{base}/browser.css");
    let (js, css, shelter) = tokio::join!(
        download(&client, &js_url, false),
        download(&client, &css_url, true),
        download(
            &client,
            "https://raw.githubusercontent.com/uwu/shelter-builds/main/shelter.js",
            false
        )
    );
    let (js, css) = (js?, css?);
    // each generation has its own directory; switch the manifest only after both writes.
    let generation = format!(
        "{}-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        std::process::id()
    );
    let next = dir.join(&generation);
    config::atomic_write(&next.join("browser.js"), js.as_bytes())?;
    config::atomic_write(&next.join("browser.css"), css.as_bytes())?;
    config::save_json(
        &dir.join("manifest.json"),
        &CacheManifest {
            updated_at: config::now(),
            generation: generation.clone(),
        },
    )?;
    let mut previous = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|e| {
            e.file_type().is_ok_and(|t| t.is_dir())
                && e.file_name()
                    .to_string_lossy()
                    .bytes()
                    .all(|b| b.is_ascii_digit() || b == b'-')
        })
        .collect::<Vec<_>>();
    previous.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
    for entry in previous.into_iter().skip(2) {
        let _ = fs::remove_dir_all(entry.path());
    }
    if let Ok(shelter) = shelter {
        config::atomic_write(&profile.join("bundles/shelter.js"), shelter.as_bytes())?
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restart_routes_all_three_bundles() {
        for m in [
            ClientMod::Vencord,
            ClientMod::Equicord,
            ClientMod::Illegalcord,
        ] {
            let js = source(m).0;
            assert!(
                patch_restarts(js).contains("window.kawaicord.restart()"),
                "{}",
                m.id()
            );
        }
    }
    #[test]
    fn csp_and_error_pages_are_not_bundles() {
        assert!(!plausible("<!doctype html>", false));
        assert!(!plausible("not found", false));
        assert!(plausible(VENCORD, false));
    }
    #[test]
    fn illegalcord_logo_is_bundled_instead_of_a_github_html_page() {
        let patched = patch_bundle(source(ClientMod::Illegalcord).0);
        assert!(!patched.contains("github.com/ImHisako/ImHisako/blob/main/Images/Illegalcord.png"));
        assert!(patched.contains("data:image/png;base64,iVBORw0KGgo"));
    }
    #[test]
    fn unrelated_reload_is_preserved() {
        assert_eq!(
            patch_restarts("cache.reload(); window.location.reload(true)"),
            "cache.reload(); window.kawaicord.restart()"
        );
    }
}
