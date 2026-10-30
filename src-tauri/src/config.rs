use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ClientMod {
    #[default]
    Vencord,
    Equicord,
    Illegalcord,
}
impl ClientMod {
    pub fn id(self) -> &'static str {
        match self {
            Self::Vencord => "vencord",
            Self::Equicord => "equicord",
            Self::Illegalcord => "illegalcord",
        }
    }
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Config {
    pub active_mod: ClientMod,
    pub performance_mode: bool,
    pub static_nameplates: bool,
    pub rich_presence: bool,
    pub detect_games: bool,
    pub tray_enabled: bool,
    pub minimize_to_tray: bool,
    pub start_at_login: bool,
    pub auto_update_mods: bool,
    pub auto_update_app: bool,
    pub preview_updates: bool,
    pub notifications: bool,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            active_mod: ClientMod::Vencord,
            performance_mode: true,
            static_nameplates: cfg!(target_os = "macos"),
            rich_presence: true,
            detect_games: false,
            tray_enabled: true,
            minimize_to_tray: true,
            start_at_login: false,
            auto_update_mods: true,
            auto_update_app: true,
            preview_updates: false,
            notifications: true,
        }
    }
}
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct WindowState {
    pub width: f64,
    pub height: f64,
    pub maximized: bool,
}
impl WindowState {
    pub fn size(&self) -> (f64, f64) {
        if self.width.is_finite()
            && self.height.is_finite()
            && (800.0..=10000.0).contains(&self.width)
            && (600.0..=8000.0).contains(&self.height)
        {
            (self.width, self.height)
        } else {
            (1180.0, 820.0)
        }
    }
}
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
pub fn read_json<T: serde::de::DeserializeOwned + Default>(path: &Path) -> T {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}
pub fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("Missing parent directory")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    let mut file = fs::File::create(&temporary).map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temporary, path).map_err(|e| {
        let _ = fs::remove_file(&temporary);
        e.to_string()
    })
}
pub fn save_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    atomic_write(
        path,
        &serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
}
#[derive(Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Recovery {
    pub clean_exit: bool,
    pub updated_at: u64,
}
impl Recovery {
    pub fn recent_crash(&self) -> bool {
        !self.clean_exit && now().saturating_sub(self.updated_at) < 120
    }
}
pub fn profile_override() -> Option<PathBuf> {
    let args: Vec<_> = std::env::args().collect();
    args.windows(2)
        .find(|p| p[0] == "--profile")
        .map(|p| PathBuf::from(&p[1]))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mod_selection_rejects_unknown_names() {
        assert!(serde_json::from_str::<Config>(r#"{"activeMod":"invalid"}"#).is_err());
        for id in ["vencord", "equicord", "illegalcord"] {
            let c: Config = serde_json::from_value(serde_json::json!({"activeMod":id})).unwrap();
            assert_eq!(c.active_mod.id(), id);
        }
    }
    #[test]
    fn invalid_saved_size_recovers() {
        assert_eq!(WindowState::default().size(), (1180.0, 820.0));
        assert_eq!(
            WindowState {
                width: f64::INFINITY,
                height: 600.0,
                maximized: false
            }
            .size(),
            (1180.0, 820.0)
        );
    }
    #[test]
    fn background_defaults_keep_services_alive() {
        let c = Config::default();
        assert!(c.rich_presence && c.notifications && c.performance_mode);
    }
}

pub fn load_config(path: &Path) -> Result<Config, String> {
    let config = if path.exists() {
        let bytes = fs::read(path).map_err(|error| error.to_string())?;
        match serde_json::from_slice::<Config>(&bytes) {
            Ok(config) => config,
            Err(_) => {
                fs::copy(path, path.with_extension(format!("corrupt-{}.json", now())))
                    .map_err(|error| error.to_string())?;
                Config::default()
            }
        }
    } else {
        Config::default()
    };
    save_json(path, &config)?;
    Ok(config)
}

#[cfg(test)]
mod installation_tests {
    use super::*;
    #[test]
    fn installation_defaults_are_saved_and_existing_choices_survive() {
        let dir = std::env::temp_dir().join(format!(
            "kawaicord-config-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join("config.json");
        let mut config = load_config(&path).unwrap();
        assert!(path.exists());
        assert!(config.notifications);
        assert!(config.minimize_to_tray);
        assert!(!config.preview_updates);
        assert!(!config.start_at_login);
        assert!(!config.detect_games);
        config.active_mod = ClientMod::Illegalcord;
        config.notifications = false;
        save_json(&path, &config).unwrap();
        let restored = load_config(&path).unwrap();
        assert_eq!(restored.active_mod, ClientMod::Illegalcord);
        assert!(!restored.notifications);
        std::fs::write(&path, b"broken settings").unwrap();
        load_config(&path).unwrap();
        assert!(std::fs::read_dir(&dir)
            .unwrap()
            .any(|entry| std::fs::read(entry.unwrap().path())
                .is_ok_and(|bytes| bytes == b"broken settings")));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
