//! optional, infrequent process detection. disabled by default; sdk-based rpc
//! stays available without a scanner. never refreshes cpu, memory, or threads.
use crate::activity_host::ActivityHost as AppHandle;
use serde::Deserialize;
use serde_json::json;
use std::{collections::HashMap, sync::Arc};
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};
use tokio::sync::watch;
#[derive(Deserialize, Clone)]
struct Executable {
    name: String,
    os: String,
    #[serde(default)]
    arguments: Option<String>,
    #[serde(default)]
    is_launcher: bool,
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
struct Rule {
    name: String,
    arguments: Vec<String>,
    game: Arc<GameIdentity>,
}
struct GameIdentity {
    id: String,
    name: String,
}
type Index = HashMap<String, Vec<Rule>>;
fn index(games: Vec<Game>, platform: &str) -> Index {
    let mut index: Index = HashMap::new();
    for game in games {
        let identity = Arc::new(GameIdentity {
            id: game.id,
            name: game.name,
        });
        for executable in game.executables {
            if executable.os != platform || executable.is_launcher {
                continue;
            }
            let name = executable
                .name
                .trim_start_matches('>')
                .to_lowercase()
                .replace('\\', "/");
            let key = name.rsplit('/').next().unwrap_or_default().to_owned();
            index.entry(key).or_default().push(Rule {
                name,
                arguments: executable
                    .arguments
                    .unwrap_or_default()
                    .split_whitespace()
                    .map(str::to_owned)
                    .collect(),
                game: identity.clone(),
            });
        }
    }
    index
}
fn candidates<'a>(index: &'a Index, path: &str, name: &str) -> Vec<&'a Rule> {
    let basename = path.rsplit('/').next().unwrap_or_default();
    let mut keys = vec![basename];
    if name != basename {
        keys.push(name);
    }
    for component in path.split('/') {
        if component.ends_with(".app") && !keys.contains(&component) {
            keys.push(component);
        }
    }
    keys.into_iter()
        .filter_map(|key| index.get(key))
        .flatten()
        .filter(|rule| matches(path, &rule.name))
        .collect()
}
fn arguments_match(command: &[std::ffi::OsString], required: &[String]) -> bool {
    required.is_empty()
        || command.windows(required.len()).any(|window| {
            window
                .iter()
                .zip(required)
                .all(|(actual, expected)| actual == expected.as_str())
        })
}
pub async fn run(app: AppHandle, mut stop: watch::Receiver<bool>) {
    let mut database: Option<Index> = None;
    let mut system = System::new();
    let mut active: HashMap<String, (u32, u64)> = HashMap::new();
    loop {
        let enabled = app
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
                index(
                    serde_json::from_str(include_str!("../../native-data/games.json"))
                        .unwrap_or_default(),
                    platform,
                )
            });
            system.refresh_processes_specifics(
                ProcessesToUpdate::All,
                true,
                ProcessRefreshKind::nothing()
                    .without_tasks()
                    .with_exe(UpdateKind::OnlyIfNotSet),
            );
            let probes: Vec<_> = system
                .processes()
                .iter()
                .filter_map(|(pid, process)| {
                    let path = process
                        .exe()
                        .map(|p| p.to_string_lossy().to_lowercase().replace('\\', "/"))
                        .unwrap_or_default();
                    let name = process.name().to_string_lossy().to_lowercase();
                    let rules = candidates(index, &path, &name);
                    (!rules.is_empty()).then_some((*pid, rules))
                })
                .collect();
            let command_pids: Vec<_> = probes
                .iter()
                .filter(|(_, rules)| rules.iter().any(|rule| !rule.arguments.is_empty()))
                .map(|(pid, _)| *pid)
                .collect();
            if !command_pids.is_empty() {
                system.refresh_processes_specifics(
                    ProcessesToUpdate::Some(&command_pids),
                    false,
                    ProcessRefreshKind::nothing()
                        .without_tasks()
                        .with_cmd(UpdateKind::OnlyIfNotSet),
                );
            }
            let mut found: HashMap<String, (u32, Arc<GameIdentity>)> = HashMap::new();
            for (pid, rules) in probes {
                let Some(process) = system.process(pid) else {
                    continue;
                };
                for rule in rules {
                    if arguments_match(process.cmd(), &rule.arguments) {
                        let current = pid.as_u32();
                        let existing = active
                            .get(&rule.game.id)
                            .is_some_and(|(pid, _)| *pid == current);
                        if !found.contains_key(&rule.game.id) || existing {
                            found.insert(rule.game.id.clone(), (current, rule.game.clone()));
                        }
                    }
                }
            }
            for (id, (pid, game)) in &found {
                let previous = active.get(id).copied();
                let started = previous
                    .filter(|p| p.0 == *pid)
                    .map(|p| p.1)
                    .unwrap_or_else(super::config::now);
                if previous != Some((*pid, started)) {
                    active.insert(id.clone(), (*pid, started));
                    super::rpc::relay(
                        &app,
                        json!({"socketId":format!("game-{id}"),"pid":pid,"activity":{"application_id":id,"name":game.name,"type":0,"timestamps":{"start":started*1000}}}),
                    );
                }
            }
            let ended = active
                .keys()
                .filter(|id| !found.contains_key(*id))
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
        if enabled {
            tokio::select! {_=stop.changed()=>break,_=tokio::time::sleep(std::time::Duration::from_secs(30))=>{},_=app.changed.notified()=>{}}
        } else {
            tokio::select! {_=stop.changed()=>break,_=app.changed.notified()=>{}}
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
        assert!(!matches(
            "/Applications/Not Game.app/Contents/MacOS/Game",
            "game.app"
        ));
    }
}

#[cfg(test)]
mod detection_tests {
    use super::*;
    #[test]
    fn matches_macos_bundle_and_linux_full_executable_names() {
        let games = serde_json::from_value(serde_json::json!([
            {"id":"1","name":"a","executables":[{"name":"game.app","os":"darwin"}]},
            {"id":"2","name":"b","executables":[{"name":"long-game-executable","os":"linux"}]}
        ]))
        .unwrap();
        let mac = index(games, "darwin");
        assert_eq!(
            candidates(
                &mac,
                "/applications/game.app/contents/macos/actual-binary",
                "actual-binary"
            )
            .len(),
            1
        );
        let linux = index(serde_json::from_value(serde_json::json!([{ "id":"2","name":"b","executables":[{"name":"long-game-executable","os":"linux"}]}])).unwrap(), "linux");
        assert_eq!(
            candidates(&linux, "/games/long-game-executable", "long-game-execu").len(),
            1
        );
    }
    #[test]
    fn shared_engines_require_exact_argument_tokens_and_skip_launchers() {
        let required = vec!["-game".into(), "tf".into()];
        assert!(arguments_match(
            &["hl2.exe".into(), "-game".into(), "tf".into()],
            &required
        ));
        assert!(!arguments_match(
            &["hl2.exe".into(), "-game".into(), "tf2".into()],
            &required
        ));
        assert!(!arguments_match(
            &["hl2.exe".into(), "--title=-game tf".into()],
            &required
        ));
        let games = serde_json::from_value(serde_json::json!([{ "id":"1","name":"a","executables":[{"name":"launcher.exe","os":"win32","is_launcher":true}]}])).unwrap();
        assert!(index(games, "win32").is_empty());
    }
}
