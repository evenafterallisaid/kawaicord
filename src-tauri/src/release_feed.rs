use serde::Deserialize;
#[derive(Deserialize)]
pub struct Asset {
    pub name: String,
    pub browser_download_url: String,
    #[serde(default, rename = "url")]
    pub api_url: String,
}
#[derive(Deserialize)]
pub struct Release {
    pub draft: bool,
    pub prerelease: bool,
    pub assets: Vec<Asset>,
    pub tag_name: String,
}

pub fn select_manifest(
    releases: &[Release],
    allow_preview: bool,
) -> Option<(semver::Version, &Asset)> {
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
}

pub fn manifest_urls(asset: &Asset) -> Vec<url::Url> {
    let mut endpoints = Vec::with_capacity(2);
    for candidate in [&asset.api_url, &asset.browser_download_url] {
        let Ok(url) = url::Url::parse(candidate) else {
            continue;
        };
        if url.scheme() != "https"
            || url.port_or_known_default() != Some(443)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            continue;
        }
        let valid = match url.host_str() {
            Some("api.github.com") => url
                .path()
                .strip_prefix("/repos/evenafterallisaid/kawaicord/releases/assets/")
                .is_some_and(|id| !id.is_empty() && id.bytes().all(|byte| byte.is_ascii_digit())),
            Some("github.com") => {
                url.path()
                    .starts_with("/evenafterallisaid/kawaicord/releases/download/")
                    && url.path().ends_with("/latest.json")
            }
            _ => false,
        };
        if valid && !endpoints.contains(&url) {
            endpoints.push(url);
        }
    }
    endpoints
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_projects_manifest_endpoints_are_allowed() {
        let mut asset = Asset {
            name: "latest.json".into(),
            browser_download_url: "https://github.com/evenafterallisaid/kawaicord/releases/download/v2.0.2/latest.json".into(),
            api_url: "https://api.github.com/repos/evenafterallisaid/kawaicord/releases/assets/123".into(),
        };
        let urls = manifest_urls(&asset);
        assert_eq!(urls.len(), 2);
        assert_eq!(urls[0].as_str(), asset.api_url);
        asset.api_url.push_str("/other");
        assert_eq!(manifest_urls(&asset).len(), 1);
        asset.browser_download_url = asset
            .browser_download_url
            .replace("github.com", "github.com.example.org");
        assert!(manifest_urls(&asset).is_empty());
    }
}
