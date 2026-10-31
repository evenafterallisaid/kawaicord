mod activity_host;
mod bundles;
mod cloud_client;
mod config;
mod core_updater;
mod games;
mod release_feed;
mod rpc;
mod spotify_bridge;
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Write,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};

struct Output(Mutex<std::io::Stdout>);
impl Output {
    fn send(&self, value: Value) {
        if let Ok(mut output) = self.0.lock() {
            let _ = serde_json::to_writer(&mut *output, &value);
            let _ = output.write_all(b"\n");
            let _ = output.flush();
        }
    }
}
struct Core {
    profile: PathBuf,
    config: Arc<Mutex<config::Config>>,
    changed: Arc<tokio::sync::Notify>,
    output: Arc<Output>,
    runtime: Mutex<Value>,
    rpc: tokio::sync::Mutex<Option<rpc::Service>>,
    updater: core_updater::Updater,
    refreshing: AtomicBool,
    safe: bool,
    smoke: bool,
}
impl Core {
    fn host(&self) -> activity_host::ActivityHost {
        let output = self.output.clone();
        activity_host::ActivityHost::new(self.config.clone(), self.changed.clone(), move |data| {
            output.send(json!({"event":"activity","data":data}))
        })
    }
    async fn configure_rpc(&self) {
        let enabled = !self.smoke && self.config.lock().unwrap().rich_presence;
        let mut service = self.rpc.lock().await;
        if enabled && service.is_none() {
            match rpc::Service::start(self.host()).await {
                Ok(value) => *service = Some(value),
                Err(error) => eprintln!("Rich Presence unavailable: {error}"),
            }
        } else if !enabled {
            *service = None;
        }
    }
    fn instance_profile(&self, id: Option<&str>) -> Result<PathBuf, String> {
        let Some(id) = id else {
            return Ok(self.profile.clone());
        };
        if id.is_empty()
            || id.len() > 32
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("Invalid instance identifier".into());
        }
        let digest = Sha256::digest(id.as_bytes());
        Ok(self.profile.join("instances").join(format!("{digest:x}")))
    }
    fn recovery(&self, clean: bool) -> Result<(), String> {
        config::save_json(
            &self.profile.join("recovery.json"),
            &config::Recovery {
                clean_exit: clean,
                updated_at: config::now(),
            },
        )
    }
    async fn request(self: &Arc<Self>, command: &str, args: Value) -> Result<Value, String> {
        match command {
            "initialize" => {
                let profile = self.instance_profile(args["id"].as_str())?;
                std::fs::create_dir_all(&profile).map_err(|error| error.to_string())?;
                let mut config = self.config.lock().unwrap().clone();
                if args["id"].is_string() {
                    config.spotify_local_playback = false;
                }
                if let Some(value) = args["performanceMode"].as_bool() {
                    config.performance_mode = value;
                }
                let script = bundles::initialization(
                    &self.profile,
                    config.active_mod,
                    self.safe || args["safeMode"].as_bool().unwrap_or(false),
                    &config,
                )?;
                Ok(json!(script))
            }
            "get_settings" => Ok(
                json!({"config":self.config.lock().unwrap().clone(),"runtime":self.runtime.lock().unwrap().clone(),"updater":self.updater.status()}),
            ),
            "save_config" => {
                let config: config::Config = serde_json::from_value(args["config"].clone())
                    .map_err(|error| error.to_string())?;
                config::save_json(&self.profile.join("config.json"), &config)?;
                *self.config.lock().unwrap() = config.clone();
                self.changed.notify_one();
                self.configure_rpc().await;
                if !config.spotify_local_playback {
                    spotify_bridge::disable().await;
                }
                Ok(json!(config))
            }
            "spotify_bridge" => {
                let request: spotify_bridge::Request =
                    serde_json::from_value(args["request"].clone()).map_err(|e| e.to_string())?;
                let enabled = !self.smoke && self.config.lock().unwrap().spotify_local_playback;
                let status = spotify_bridge::request(&self.profile, enabled, request).await?;
                serde_json::to_value(status).map_err(|e| e.to_string())
            }
            "cloud_request" => {
                let request: cloud_client::Request =
                    serde_json::from_value(args["request"].clone())
                        .map_err(|error| error.to_string())?;
                let response = cloud_client::perform(
                    args["origin"].as_str().ok_or("Missing cloud origin")?,
                    request,
                )
                .await?;
                serde_json::to_value(response).map_err(|error| error.to_string())
            }
            "report_runtime" => {
                let status = args["status"].clone();
                config::save_json(&self.profile.join("runtime.json"), &status)?;
                if status["ready"] == true {
                    core_updater::cleanup_backup(&self.profile);
                }
                *self.runtime.lock().unwrap() = status;
                rpc::replay(&self.host());
                if self.config.lock().unwrap().auto_update_mods && !self.smoke {
                    let core = self.clone();
                    tokio::spawn(async move {
                        let _ = core.refresh(false).await;
                    });
                }
                Ok(Value::Null)
            }
            "refresh_mods" => {
                self.refresh(true).await?;
                Ok(Value::Null)
            }
            "check_update" => {
                let preview = self.config.lock().unwrap().preview_updates;
                serde_json::to_value(self.updater.check(preview).await?)
                    .map_err(|error| error.to_string())
            }
            "install_update" => {
                let preview = self.config.lock().unwrap().preview_updates;
                self.updater.install(&self.profile, preview).await?;
                self.recovery(true)?;
                Ok(json!({"restart":true}))
            }
            "shutdown" => {
                self.recovery(true)?;
                *self.rpc.lock().await = None;
                Ok(Value::Null)
            }
            _ => Err("Unsupported core command".into()),
        }
    }
    async fn refresh(&self, force: bool) -> Result<(), String> {
        if self.refreshing.swap(true, Ordering::AcqRel) {
            return Err("A mod refresh is already running".into());
        }
        let selected = self.config.lock().unwrap().active_mod;
        let result = bundles::refresh(&self.profile, selected, force).await;
        self.refreshing.store(false, Ordering::Release);
        result
    }
}
#[derive(Deserialize)]
struct Request {
    id: u64,
    command: String,
    #[serde(default)]
    args: Value,
}
#[tokio::main(worker_threads = 2)]
async fn main() {
    env_logger::init();
    let Some(profile) = config::profile_override() else {
        eprintln!("The Chromium host must provide its profile directory.");
        std::process::exit(1);
    };
    let result = run(profile).await;
    if let Err(error) = result {
        eprintln!("Core startup failed: {error}");
        std::process::exit(1);
    }
}
async fn run(profile: PathBuf) -> Result<(), String> {
    let config = config::load_config(&profile.join("config.json"))?;
    let recovery: config::Recovery = config::read_json(&profile.join("recovery.json"));
    let requested = std::fs::read(profile.join("safe-mode.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<bool>(&bytes).ok());
    let _ = std::fs::remove_file(profile.join("safe-mode.json"));
    let safe = requested.unwrap_or_else(|| {
        std::env::args().any(|arg| arg == "--safe-mode") || recovery.recent_crash()
    });
    let saved: config::WindowState = config::read_json(&profile.join("window.json"));
    let (width, height) = saved.size();
    let saved = json!({"width":width,"height":height,"maximized":saved.maximized});
    let output = Arc::new(Output(Mutex::new(std::io::stdout())));
    let runtime = json!({"activeMod":config.active_mod,"safeMode":safe,"ready":false,"shelter":false,"modules":0,"media":false,"screenSharing":false,"error":null,"version":env!("CARGO_PKG_VERSION"),"platform":"linux"});
    let core = Arc::new(Core {
        profile,
        config: Arc::new(Mutex::new(config)),
        changed: Arc::new(tokio::sync::Notify::new()),
        output: output.clone(),
        runtime: Mutex::new(runtime),
        rpc: tokio::sync::Mutex::new(None),
        updater: Default::default(),
        refreshing: AtomicBool::new(false),
        safe,
        smoke: std::env::args().any(|arg| arg == "--smoke-test"),
    });
    core.recovery(false)?;
    core.configure_rpc().await;
    output.send(json!({"event":"ready","config":core.config.lock().unwrap().clone(),"window":saved,"safeMode":safe,"version":env!("CARGO_PKG_VERSION")}));
    let mut stdin = BufReader::new(tokio::io::stdin());
    let semaphore = Arc::new(tokio::sync::Semaphore::new(8));
    loop {
        let mut line = Vec::new();
        let bytes = (&mut stdin)
            .take(48 * 1024 * 1024 + 1)
            .read_until(b'\n', &mut line)
            .await
            .map_err(|error| error.to_string())?;
        if bytes == 0 {
            break;
        }
        if line.len() > 48 * 1024 * 1024 {
            return Err("Core request exceeds its size limit".into());
        }
        let request: Request = serde_json::from_slice(&line).map_err(|error| error.to_string())?;
        if request.command == "shutdown" {
            let result = core.request(&request.command, request.args).await;
            output.send(match result {
                Ok(value) => json!({"id":request.id,"value":value}),
                Err(error) => json!({"id":request.id,"error":error}),
            });
            break;
        }
        let permit = semaphore
            .clone()
            .acquire_owned()
            .await
            .map_err(|error| error.to_string())?;
        let core = core.clone();
        let output = output.clone();
        tokio::spawn(async move {
            let _permit = permit;
            let result = core.request(&request.command, request.args).await;
            output.send(match result {
                Ok(value) => json!({"id":request.id,"value":value}),
                Err(error) => json!({"id":request.id,"error":error}),
            });
        });
    }
    Ok(())
}
