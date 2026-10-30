use serde::Deserialize;
#[derive(Deserialize)]
pub struct Asset {
    pub name: String,
    pub browser_download_url: String,
}
#[derive(Deserialize)]
pub struct Release {
    pub draft: bool,
    pub prerelease: bool,
    pub assets: Vec<Asset>,
    pub tag_name: String,
}

pub fn select_manifest(releases: &[Release], allow_preview: bool) -> Option<&Asset> {
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
