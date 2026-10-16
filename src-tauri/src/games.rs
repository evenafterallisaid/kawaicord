//! optional, infrequent process detection. disabled by default; sdk-based rpc
//! stays available without a scanner. never refreshes cpu, memory, or threads.
use serde::Deserialize;
use serde_json::json;
use std::collections::{HashMap, HashSet};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tauri::{AppHandle, Manager};
use tokio::sync::watch;
#[derive(Deserialize, Clone)]
struct Executable {
    name: String,
    os: String,
    #[serde(default)]
    arguments: Option<String>,
}
#[derive(Deserialize, Clone)]
struct Game {
    id: String,
    name: String,
    executables: Vec<Executable>,
}
fn matches(path: &str, name: &str) -> bool {
    let name = name.trim_start_matches('>');
    path == name
        || path.ends_with(&format!("/{name}"))
        || path.contains(&format!("/{name}/Contents/").to_lowercase())
}
pub async fn run(app: AppHandle, mut stop: watch::Receiver<bool>) {
    let mut database: Option<HashMap<String, Vec<Game>>> = None;
    let mut system = System::new();
    let mut active: HashMap<String, (u32, u64)> = HashMap::new();
    loop {
        let enabled = app
            .state::<super::AppState>()
            .config
            .lock()
            .is_ok_and(|c| c.rich_presence && c.detect_games);
        if enabled {
            let index = database.get_or_insert_with(|| {
                let platform = match std::env::consts::OS {
                    "macos" => "darwin",
                    "windows" => "win32",
                    other => other,
                };
                let games: Vec<Game> =
                    serde_json::from_str(include_str!("../../native-data/games.json"))
                        .unwrap_or_default();
                let mut index: HashMap<String, Vec<Game>> = HashMap::new();
                for game in games {
                    for executable in &game.executables {
                        if executable.os == platform {
                            let key = executable
                                .name
                                .trim_start_matches('>')
                                .rsplit('/')
                                .next()
                                .unwrap_or_default()
                                .to_lowercase();
                            index.entry(key).or_default().push(game.clone());
                        }
                    }
                }
                index
            });
            system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing()
                    .without_tasks()
                    .with_exe(UpdateKind::OnlyIfNotSet),
            );
            let mut found = HashSet::new();
            for (pid, process) in system.processes() {
                let path = process
                    .exe()
                    .map(|p| p.to_string_lossy().to_lowercase().replace('\\', "/"))
                    .unwrap_or_default();
                let name = process.name().to_string_lossy().to_lowercase();
                if let Some(candidates) = index.get(&name) {
                    for game in candidates {
                        if game.executables.iter().any(|e| {
                            e.arguments.is_none() && matches(&path, &e.name.to_lowercase())
                        }) {
                            found.insert(game.id.clone());
                            let pid = pid.as_u32();
                            let previous = active.get(&game.id).copied();
                            let started = previous
                                .filter(|p| p.0 == pid)
                                .map(|p| p.1)
                                .unwrap_or_else(super::config::now);
                            if previous != Some((pid, started)) {
                                active.insert(game.id.clone(), (pid, started));
                                super::rpc::relay(
                                    &app,
                                    json!({"socketId":format!("game-{}",game.id),"pid":pid,"activity":{"application_id":game.id,"name":game.name,"type":0,"timestamps":{"start":started*1000}}}),
                                );
                            }
                        }
                    }
                }
            }
            let ended = active
                .keys()
                .filter(|id| !found.contains(*id))
                .cloned()
                .collect::<Vec<_>>();
            for id in ended {
                active.remove(&id);
                super::rpc::relay(
                    &app,
                    json!({"socketId":format!("game-{id}"),"activity":null}),
                );
            }
        } else {
            for id in active.keys() {
                super::rpc::relay(
                    &app,
                    json!({"socketId":format!("game-{id}"),"activity":null}),
                );
            }
            active.clear();
            database = None;
            system = System::new();
        }
        let state = app.state::<super::AppState>();
        if enabled {
            tokio::select! {_=stop.changed()=>break,_=tokio::time::sleep(std::time::Duration::from_secs(30))=>{},_=state.config_changed.notified()=>{}}
        } else {
            tokio::select! {_=stop.changed()=>break,_=state.config_changed.notified()=>{}}
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn avoids_filename_suffix_false_positives() {
        assert!(matches("c:/games/game.exe", "game.exe"));
        assert!(!matches("c:/games/not-game.exe", "game.exe"));
    }
}
