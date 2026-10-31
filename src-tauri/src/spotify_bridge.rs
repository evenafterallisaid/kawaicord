//! optional local spotify playback. no account tokens, remote listener, or idle polling.
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::{
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::watch,
    task::{JoinHandle, JoinSet},
};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{ErrorResponse, Request as Handshake, Response},
        protocol::WebSocketConfig,
        Message,
    },
};

const PORT: u16 = 19779;
const ROUTE: &str = "/kawaicord-listen-along";
const EXTENSION: &str = "kawaicordListenAlong.js";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Snapshot {
    pub session: String,
    pub uri: String,
    pub start_ms: u64,
    pub duration_ms: u64,
    #[serde(default)]
    pub paused: bool,
}
impl Snapshot {
    fn valid(&self) -> bool {
        let id = self.uri.strip_prefix("spotify:track:").unwrap_or_default();
        let now = crate::config::now().saturating_mul(1000);
        !self.session.is_empty()
            && self.session.len() <= 64
            && self
                .session
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            && id.len() == 22
            && id.bytes().all(|b| b.is_ascii_alphanumeric())
            && self.duration_ms <= 3_600_000
            && self.start_ms <= now + 30_000
            && now.saturating_sub(self.start_ms)
                < if self.duration_ms == 0 {
                    3_600_000
                } else {
                    self.duration_ms + 30_000
                }
    }
}
#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "lowercase", deny_unknown_fields)]
pub enum Request {
    Status,
    Publish {
        snapshot: Snapshot,
        #[serde(default)]
        restart: bool,
        #[serde(default)]
        pending: bool,
    },
    Stop,
    Install,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub connected: bool,
    pub outcome: String,
    pub message: String,
}
#[derive(Clone, Default, Serialize)]
struct Frame {
    revision: u64,
    snapshot: Option<Snapshot>,
    restart: bool,
    pending: bool,
}
struct Service {
    shutdown: watch::Sender<bool>,
    task: JoinHandle<()>,
}
impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.shutdown.send(true);
        self.task.abort();
    }
}
struct Bridge {
    service: tokio::sync::Mutex<Option<Service>>,
    frame: watch::Sender<Frame>,
    connected: AtomicBool,
    blocked: Mutex<Option<String>>,
    outcome: Mutex<String>,
}
fn bridge() -> &'static Arc<Bridge> {
    static VALUE: OnceLock<Arc<Bridge>> = OnceLock::new();
    VALUE.get_or_init(|| {
        Arc::new(Bridge {
            service: Default::default(),
            frame: watch::channel(Frame::default()).0,
            connected: AtomicBool::new(false),
            blocked: Default::default(),
            outcome: Mutex::new("idle".into()),
        })
    })
}
fn key(profile: &Path) -> Result<String, String> {
    static LOCK: Mutex<()> = Mutex::new(());
    let _lock = LOCK.lock().map_err(|e| e.to_string())?;
    let file = profile.join("spotify-companion-key.json");
    if file.exists() {
        let value: String =
            serde_json::from_slice(&std::fs::read(&file).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit()) {
            return Ok(value);
        }
        return Err("The Spotify companion pairing key is invalid. Restore its backup before pairing again.".into());
    }
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|e| e.to_string())?;
    let value: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    let mut options = std::fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&file).map_err(|e| e.to_string())?;
    serde_json::to_writer(&file, &value).map_err(|e| e.to_string())?;
    file.sync_all().map_err(|e| e.to_string())?;
    Ok(value)
}
fn authorized(req: &Handshake, expected: &str) -> bool {
    req.headers().get("Origin").and_then(|v| v.to_str().ok())
        == Some("https://xpui.app.spotify.com")
        && req.uri().path() == ROUTE
        && req.uri().query() == Some(format!("key={expected}").as_str())
}
fn status(message: impl Into<String>) -> Status {
    let b = bridge();
    Status {
        connected: b.connected.load(Ordering::Acquire),
        outcome: b.outcome.lock().unwrap().clone(),
        message: message.into(),
    }
}
pub async fn disable() {
    let b = bridge();
    *b.service.lock().await = None;
    b.frame.send_modify(|f| {
        f.revision += 1;
        f.snapshot = None;
    });
    *b.blocked.lock().unwrap() = None;
}
pub async fn request(profile: &Path, enabled: bool, request: Request) -> Result<Status, String> {
    if matches!(request, Request::Install) {
        let profile = profile.to_owned();
        let message = tokio::task::spawn_blocking(move || install(&profile))
            .await
            .map_err(|e| e.to_string())??;
        return Ok(status(message));
    }
    if !enabled {
        disable().await;
        return Ok(status("Local Spotify playback is disabled."));
    }
    let b = bridge();
    let mut service = b.service.lock().await;
    if service.is_none() {
        let pairing = key(profile)?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, PORT))
            .await
            .map_err(|_| {
                "Spotify bridge port is already in use. Close another Kawaicord copy and retry."
                    .to_string()
            })?;
        let (shutdown, mut stop) = watch::channel(false);
        let owner = b.clone();
        let task = tokio::spawn(async move {
            let mut peers = JoinSet::new();
            loop {
                tokio::select! {
                    _ = stop.changed() => break,
                    Some(_) = peers.join_next(), if !peers.is_empty() => {},
                    incoming = listener.accept() => {
                        let Ok((socket,_)) = incoming else { break; };
                        if !peers.is_empty() { continue; }
                        let owner = owner.clone(); let pairing = pairing.clone(); let stop = stop.clone();
                        peers.spawn(async move {
                            let config = WebSocketConfig::default().max_message_size(Some(4096)).max_frame_size(Some(4096));
                            // tungstenite's callback requires this exact HTTP response error type.
                            #[allow(clippy::result_large_err)]
                            let handshake = accept_hdr_async_with_config(socket,move |req: &Handshake, response: Response| {
                                if authorized(req,&pairing) { Ok(response) } else { let mut denied = ErrorResponse::new(Some("Unpaired Spotify companion".into())); *denied.status_mut()=http_status(); Err(denied) }
                            },Some(config));
                            if let Ok(Ok(ws)) = tokio::time::timeout(Duration::from_secs(5),handshake).await { peer(owner,ws,stop).await; }
                        });
                    }
                }
            }
        });
        *service = Some(Service { shutdown, task });
    }
    drop(service);
    match request {
        Request::Publish {
            snapshot,
            restart,
            pending,
        } => {
            if !snapshot.valid() {
                return Err("Invalid or expired Spotify listening target".into());
            }
            if b.blocked.lock().unwrap().as_ref() != Some(&snapshot.session) {
                b.frame.send_if_modified(|f| {
                    if !restart && f.snapshot.as_ref() == Some(&snapshot) && f.pending == pending {
                        false
                    } else {
                        f.revision += 1;
                        f.snapshot = Some(snapshot);
                        f.restart = restart;
                        f.pending = pending;
                        true
                    }
                });
            }
        }
        Request::Stop => {
            b.frame.send_if_modified(|f| {
                if f.snapshot.is_none() {
                    false
                } else {
                    f.revision += 1;
                    f.snapshot = None;
                    true
                }
            });
        }
        Request::Status => {}
        Request::Install => unreachable!(),
    }
    Ok(status(if b.connected.load(Ordering::Acquire) {
        "Spotify companion connected."
    } else {
        "Waiting for the Spotify companion. Install it, then restart Spotify."
    }))
}
// use tungstenite's re-export so both native hosts keep one HTTP implementation.
fn http_status() -> tokio_tungstenite::tungstenite::http::StatusCode {
    tokio_tungstenite::tungstenite::http::StatusCode::FORBIDDEN
}
async fn peer(
    b: Arc<Bridge>,
    mut ws: tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    mut stop: watch::Receiver<bool>,
) {
    struct Connected(Arc<Bridge>);
    impl Drop for Connected {
        fn drop(&mut self) {
            self.0.connected.store(false, Ordering::Release);
        }
    }
    b.connected.store(true, Ordering::Release);
    let _connected = Connected(b.clone());
    let mut frames = b.frame.subscribe();
    loop {
        let frame = frames.borrow_and_update().clone();
        let Ok(json) = serde_json::to_string(&frame) else {
            break;
        };
        if !matches!(
            tokio::time::timeout(Duration::from_secs(5), ws.send(Message::Text(json.into()))).await,
            Ok(Ok(()))
        ) {
            break;
        }
        loop {
            tokio::select! {
                _=stop.changed()=>return,
                changed=frames.changed()=>{if changed.is_err(){return;}break;},
                message=ws.next()=>{
                    let Some(Ok(message))=message else {return;};
                    match message {
                        Message::Text(text)=> {
                            #[derive(Deserialize)] #[serde(deny_unknown_fields)] struct Ack { revision:u64, result:String }
                            let Ok(ack)=serde_json::from_str::<Ack>(&text) else {return;};
                            if ack.revision!=b.frame.borrow().revision || !["playing","paused","manual-stop","error"].contains(&ack.result.as_str()){continue;}
                            *b.outcome.lock().unwrap()=ack.result.clone();
                            if ack.result=="manual-stop" || ack.result=="error" {
                                *b.blocked.lock().unwrap()=b.frame.borrow().snapshot.as_ref().map(|s|s.session.clone());
                                b.frame.send_modify(|f|{f.revision+=1;f.snapshot=None;f.restart=false;});
                            }
                        },
                        Message::Close(_)=>return,
                        Message::Ping(data)=>{if ws.send(Message::Pong(data)).await.is_err(){return;}}, _=>{}
                    }
                }
            }
        }
    }
}
fn install(profile: &Path) -> Result<String, String> {
    static BUSY: AtomicBool = AtomicBool::new(false);
    if BUSY.swap(true, Ordering::AcqRel) {
        return Err("Spotify companion setup is already running.".into());
    }
    struct Busy;
    impl Drop for Busy {
        fn drop(&mut self) {
            BUSY.store(false, Ordering::Release);
        }
    }
    let _busy = Busy;
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(std::path::PathBuf::from)
        .ok_or("Home folder unavailable")?;
    let exe = if cfg!(windows) {
        "spicetify.exe"
    } else {
        "spicetify"
    };
    let mut candidates = vec![home.join(".spicetify").join(exe)];
    for name in ["APPDATA", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(name) {
            candidates.push(std::path::PathBuf::from(base).join("spicetify").join(exe));
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|p| p.join(exe)));
    }
    let cli = candidates
        .into_iter()
        .find(|p| p.is_file())
        .ok_or("Install Spicetify first, then retry companion setup.")?;
    let run = |args: &[&str]| -> Result<String, String> {
        let mut command = std::process::Command::new(&cli);
        command
            .args(args)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command.spawn().map_err(|e| e.to_string())?;
        let started = std::time::Instant::now();
        while child.try_wait().map_err(|e| e.to_string())?.is_none() {
            if started.elapsed() > Duration::from_secs(60) {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Spicetify setup timed out. Repair Spicetify and retry.".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let output = child.wait_with_output().map_err(|e| e.to_string())?;
        if !output.status.success() {
            return Err(
                "Spicetify setup failed. Repair your existing Spicetify installation and retry."
                    .into(),
            );
        }
        String::from_utf8(output.stdout)
            .map(|v| v.trim().to_owned())
            .map_err(|e| e.to_string())
    };
    let directory = std::path::PathBuf::from(run(&["path", "userdata"])?);
    if !directory.is_absolute() || !directory.join("config-xpui.ini").is_file() {
        return Err("Spicetify configuration folder could not be verified.".into());
    }
    let extensions = directory.join("Extensions");
    std::fs::create_dir_all(&extensions).map_err(|e| e.to_string())?;
    let suffix = format!("kawaicord-backup-{}", crate::config::now());
    let config = directory.join("config-xpui.ini");
    std::fs::copy(&config, config.with_extension(&suffix)).map_err(|e| e.to_string())?;
    let file = extensions.join(EXTENSION);
    if file.exists() {
        std::fs::copy(&file, file.with_extension(&suffix)).map_err(|e| e.to_string())?;
    }
    let source = include_str!("../../web-dist/spotify-companion.js")
        .replace("KAWAICORD_PAIRING_KEY", &key(profile)?);
    crate::config::atomic_write(&file, source.as_bytes())?;
    run(&["-q", "config", "extensions", EXTENSION])?;
    run(&["-q", "-n", "apply"])?;
    Ok(
        "Spotify companion installed. Quit and reopen Spotify, then enable local playback below."
            .into(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn paired_companion_receives_targets_and_manual_stop_blocks_only_its_session() {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut entropy = [0u8; 8];
        getrandom::fill(&mut entropy).unwrap();
        let folder = std::env::temp_dir().join(format!(
            "kawaicord-spotify-test-{}",
            u64::from_le_bytes(entropy)
        ));
        std::fs::create_dir(&folder).unwrap();
        request(&folder, true, Request::Status).await.unwrap();
        let pairing = key(&folder).unwrap();
        let mut handshake = format!("ws://127.0.0.1:{PORT}{ROUTE}?key={pairing}")
            .into_client_request()
            .unwrap();
        handshake
            .headers_mut()
            .insert("Origin", "https://xpui.app.spotify.com".parse().unwrap());
        let (mut socket, _) = tokio_tungstenite::connect_async(handshake).await.unwrap();
        let initial = socket.next().await.unwrap().unwrap().into_text().unwrap();
        assert!(serde_json::from_str::<serde_json::Value>(&initial).unwrap()["snapshot"].is_null());
        let mut target = Snapshot {
            session: "one".into(),
            uri: "spotify:track:0123456789abcdefghijkl".into(),
            start_ms: crate::config::now() * 1000,
            duration_ms: 200000,
            paused: false,
        };
        request(
            &folder,
            true,
            Request::Publish {
                snapshot: target.clone(),
                restart: false,
                pending: false,
            },
        )
        .await
        .unwrap();
        let frame: serde_json::Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(frame["snapshot"]["uri"], target.uri);
        let mut revision = frame["revision"].as_u64().unwrap();
        request(
            &folder,
            true,
            Request::Publish {
                snapshot: target.clone(),
                restart: true,
                pending: false,
            },
        )
        .await
        .unwrap();
        let repeated: serde_json::Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(repeated["restart"], true);
        assert!(repeated["revision"].as_u64().unwrap() > revision);
        revision = repeated["revision"].as_u64().unwrap();
        socket
            .send(Message::Text(
                serde_json::json!({"revision":revision,"result":"manual-stop"})
                    .to_string()
                    .into(),
            ))
            .await
            .unwrap();
        let stopped_frame: serde_json::Value = serde_json::from_str(
            tokio::time::timeout(Duration::from_secs(2), socket.next())
                .await
                .unwrap()
                .unwrap()
                .unwrap()
                .to_text()
                .unwrap(),
        )
        .unwrap();
        assert!(stopped_frame["snapshot"].is_null());
        revision = stopped_frame["revision"].as_u64().unwrap();
        target.uri = "spotify:track:1123456789abcdefghijkl".into();
        request(
            &folder,
            true,
            Request::Publish {
                snapshot: target.clone(),
                restart: false,
                pending: false,
            },
        )
        .await
        .unwrap();
        assert_eq!(bridge().frame.borrow().revision, revision);
        target.session = "two".into();
        request(
            &folder,
            true,
            Request::Publish {
                snapshot: target.clone(),
                restart: false,
                pending: false,
            },
        )
        .await
        .unwrap();
        let next: serde_json::Value =
            serde_json::from_str(socket.next().await.unwrap().unwrap().to_text().unwrap()).unwrap();
        assert_eq!(next["snapshot"]["session"], "two");
        disable().await;
        assert!(tokio::time::timeout(Duration::from_secs(2), socket.next())
            .await
            .is_ok());
        std::fs::remove_dir_all(folder).unwrap();
    }
    #[test]
    fn targets_are_tracks_with_bounded_live_timing() {
        let mut s = Snapshot {
            session: "123-1".into(),
            uri: "spotify:track:0123456789abcdefghijkl".into(),
            start_ms: crate::config::now() * 1000,
            duration_ms: 200000,
            paused: false,
        };
        assert!(s.valid());
        s.uri = "spotify:app:other".into();
        assert!(!s.valid());
        s.uri = "spotify:track:0123456789abcdefghijkl".into();
        s.start_ms = 1;
        assert!(!s.valid());
    }
    #[test]
    fn companion_requires_its_origin_path_and_pairing_key() {
        let make = |origin: &str, path: &str| {
            Handshake::builder()
                .uri(path)
                .header("Origin", origin)
                .body(())
                .unwrap()
        };
        assert!(authorized(
            &make(
                "https://xpui.app.spotify.com",
                "/kawaicord-listen-along?key=test"
            ),
            "test"
        ));
        for origin in ["https://discord.com", "https://evil.test", "null"] {
            assert!(!authorized(
                &make(origin, "/kawaicord-listen-along?key=test"),
                "test"
            ));
        }
        assert!(!authorized(
            &make(
                "https://xpui.app.spotify.com",
                "/kawaicord-listen-along?key=wrong"
            ),
            "test"
        ));
    }
}
