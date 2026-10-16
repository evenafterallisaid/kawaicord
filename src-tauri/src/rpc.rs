//! event-driven discord rpc. no node sidecar, process scanner, or idle polling.
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt},
    sync::watch,
    task::JoinHandle,
};
use tokio_tungstenite::{
    accept_hdr_async_with_config,
    tungstenite::{
        handshake::server::{ErrorResponse, Request, Response},
        protocol::WebSocketConfig,
        Message,
    },
};
const LIMIT: usize = 64 * 1024;
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
fn valid_client(id: &str) -> bool {
    (15..=32).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_digit())
}
fn ready() -> Value {
    json!({"cmd":"DISPATCH","evt":"READY","nonce":null,"data":{"v":1,"config":{"cdn_host":"cdn.discordapp.com","api_endpoint":"//discord.com/api","environment":"production"},"user":{"id":"0","username":"Kawaicord RPC","discriminator":"0","bot":true}}})
}
static ACTIVITIES: OnceLock<Mutex<std::collections::HashMap<String, Value>>> = OnceLock::new();
fn activity_cache() -> &'static Mutex<std::collections::HashMap<String, Value>> {
    ACTIVITIES.get_or_init(Default::default)
}
pub fn replay(app: &AppHandle) {
    let events = activity_cache()
        .lock()
        .unwrap()
        .values()
        .cloned()
        .collect::<Vec<_>>();
    if let Some(w) = app.get_webview_window("main") {
        for event in events {
            let _ = w.eval(format!("window.__kawaicordActivity?.({event})"));
        }
    }
}
pub fn relay(app: &AppHandle, event: Value) {
    if let Some(id) = event["socketId"].as_str() {
        let mut cache = activity_cache().lock().unwrap();
        if event["activity"].is_null() {
            cache.remove(id);
        } else if cache.len() < 128 || cache.contains_key(id) {
            cache.insert(id.to_owned(), event.clone());
        }
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.eval(format!("window.__kawaicordActivity?.({event})"));
    }
}
fn request(app: &AppHandle, client: &str, id: u64, message: Value) -> Value {
    let cmd = message["cmd"].as_str().unwrap_or_default();
    let nonce = message.get("nonce").cloned().unwrap_or(Value::Null);
    if cmd != "SET_ACTIVITY" {
        return json!({"cmd":cmd,"nonce":nonce,"evt":"ERROR","data":{"code":4000,"message":"Unsupported RPC command"}});
    }
    let pid = message["args"].get("pid").cloned().unwrap_or(Value::Null);
    let mut activity = message["args"]["activity"].clone();
    if let Some(a) = activity.as_object_mut() {
        a.insert("application_id".into(), json!(client));
        a.entry("type").or_insert(json!(0));
        if let Some(buttons) = a.get("buttons").and_then(|v| v.as_array()).cloned() {
            a.insert(
                "metadata".into(),
                json!({"button_urls":buttons.iter().map(|b|b["url"].clone()).collect::<Vec<_>>()}),
            );
            a.insert(
                "buttons".into(),
                json!(buttons
                    .iter()
                    .map(|b| b["label"].clone())
                    .collect::<Vec<_>>()),
            );
        }
        if let Some(t) = a.get_mut("timestamps").and_then(|v| v.as_object_mut()) {
            for v in t.values_mut() {
                if let Some(n) = v.as_u64() {
                    if n < 10_000_000_000 {
                        *v = json!(n.saturating_mul(1000));
                    }
                }
            }
        }
    }
    relay(
        app,
        json!({"activity":activity,"pid":pid,"socketId":id.to_string()}),
    );
    json!({"cmd":cmd,"nonce":nonce,"evt":null,"data":activity})
}
async fn read_packet<R: AsyncRead + Unpin>(stream: &mut R) -> Result<(u32, Value), String> {
    let mut header = [0u8; 8];
    stream
        .read_exact(&mut header)
        .await
        .map_err(|e| e.to_string())?;
    let op = u32::from_le_bytes(header[..4].try_into().unwrap());
    let len = u32::from_le_bytes(header[4..].try_into().unwrap()) as usize;
    if len > LIMIT || op > 4 {
        return Err("Invalid RPC frame".into());
    }
    let mut bytes = vec![0; len];
    tokio::time::timeout(Duration::from_secs(10), stream.read_exact(&mut bytes))
        .await
        .map_err(|_| "RPC frame timed out")?
        .map_err(|e| e.to_string())?;
    Ok((
        op,
        serde_json::from_slice(&bytes).map_err(|e| e.to_string())?,
    ))
}
async fn write_packet<W: AsyncWrite + Unpin>(
    stream: &mut W,
    op: u32,
    value: &Value,
) -> Result<(), String> {
    let bytes = serde_json::to_vec(value).map_err(|e| e.to_string())?;
    let mut packet = Vec::with_capacity(bytes.len() + 8);
    packet.extend(op.to_le_bytes());
    packet.extend((bytes.len() as u32).to_le_bytes());
    packet.extend(bytes);
    stream.write_all(&packet).await.map_err(|e| e.to_string())
}
async fn connection<S: AsyncRead + AsyncWrite + Unpin>(
    mut stream: S,
    app: AppHandle,
    mut stop: watch::Receiver<bool>,
) {
    let id = NEXT_ID.fetch_add(1, Ordering::Relaxed);
    let run = async {
        let (op, handshake) =
            tokio::time::timeout(Duration::from_secs(5), read_packet(&mut stream))
                .await
                .map_err(|_| "RPC handshake timed out")??;
        let client = handshake["client_id"].as_str().unwrap_or_default();
        if op != 0 || handshake["v"] != 1 || !valid_client(client) {
            return Err("Invalid handshake".into());
        }
        write_packet(&mut stream, 1, &ready()).await?;
        loop {
            tokio::select! {_ = stop.changed()=>break, packet=read_packet(&mut stream)=>{let(op,message)=packet?;match op{1=>write_packet(&mut stream,1,&request(&app,client,id,message)).await?,2=>break,3=>write_packet(&mut stream,4,&message).await?,4=>{},_=>return Err("Repeated handshake".into())}}}
        }
        Ok::<(), String>(())
    };
    let _ = run.await;
    relay(&app, json!({"activity":null,"socketId":id.to_string()}));
}
pub struct Service {
    app: AppHandle,
    stop: watch::Sender<bool>,
    tasks: Vec<JoinHandle<()>>,
    socket: Option<PathBuf>,
}
impl Drop for Service {
    fn drop(&mut self) {
        let ids = activity_cache()
            .lock()
            .unwrap()
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        for id in ids {
            relay(&self.app, json!({"socketId":id,"activity":null}));
        }
        let _ = self.stop.send(true);
        for task in &self.tasks {
            task.abort();
        }
        if let Some(path) = &self.socket {
            let _ = std::fs::remove_file(path);
        }
    }
}
impl Service {
    // tungstenite requires its concrete response type in the handshake callback.
    #[allow(clippy::result_large_err)]
    pub async fn start(app: AppHandle) -> Result<Self, String> {
        let (tx, rx) = watch::channel(false);
        let mut service = Self {
            app: app.clone(),
            stop: tx,
            tasks: vec![],
            socket: None,
        };
        #[cfg(unix)]
        {
            use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
            let base = std::env::var_os("XDG_RUNTIME_DIR")
                .or_else(|| std::env::var_os("TMPDIR"))
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            let mut listener = None;
            for index in 0..10 {
                let path = base.join(format!("discord-ipc-{index}"));
                if let Ok(meta) = std::fs::symlink_metadata(&path) {
                    // never remove a live socket, symlink, or another user's file.
                    if !meta.file_type().is_socket() || meta.uid() != unsafe { libc::geteuid() } {
                        continue;
                    }
                    if !matches!(tokio::net::UnixStream::connect(&path).await,Err(e) if e.kind()==std::io::ErrorKind::ConnectionRefused)
                    {
                        continue;
                    }
                    let _ = std::fs::remove_file(&path);
                }
                if let Ok(l) = tokio::net::UnixListener::bind(&path) {
                    let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
                    service.socket = Some(path);
                    listener = Some(l);
                    break;
                }
            }
            let listener = listener.ok_or("No free Discord IPC socket")?;
            let app = app.clone();
            let mut stop = rx.clone();
            service.tasks.push(tokio::spawn(async move{let semaphore=Arc::new(tokio::sync::Semaphore::new(24));loop{tokio::select!{_=stop.changed()=>break,result=listener.accept()=>{if let Ok((stream,_))=result{if let Ok(permit)=semaphore.clone().try_acquire_owned(){let app=app.clone();let stop=stop.clone();tokio::spawn(async move{let _permit=permit;connection(stream,app,stop).await;});}}}}}}));
        }
        #[cfg(windows)]
        {
            use tokio::net::windows::named_pipe::ServerOptions;
            let mut selected = None;
            for index in 0..10 {
                let name = format!(r"\\.\pipe\discord-ipc-{index}");
                if let Ok(server) = ServerOptions::new().first_pipe_instance(true).create(&name) {
                    selected = Some((name, server));
                    break;
                }
            }
            let (name, mut server) = selected.ok_or("No free Discord IPC pipe")?;
            let app = app.clone();
            let mut stop = rx.clone();
            service.tasks.push(tokio::spawn(async move{loop{tokio::select!{_=stop.changed()=>break,result=server.connect()=>{if result.is_err(){break}let next=match ServerOptions::new().create(&name){Ok(s)=>s,Err(_)=>break};let connected=std::mem::replace(&mut server,next);let app=app.clone();let stop=stop.clone();tokio::spawn(connection(connected,app,stop));}}}}));
        }
        // browser-compatible rpc transport. bind only to loopback, validate browser origins.
        let game_app = app.clone();
        let game_stop = rx.clone();
        service
            .tasks
            .push(tokio::spawn(crate::games::run(game_app, game_stop)));
        for port in 6463..6473 {
            if let Ok(listener) =
                tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).await
            {
                let mut stop = rx.clone();
                service.tasks.push(tokio::spawn(async move{let semaphore=Arc::new(tokio::sync::Semaphore::new(24));loop{tokio::select!{_=stop.changed()=>break,result=listener.accept()=>{if let Ok((stream,_))=result{if let Ok(permit)=semaphore.clone().try_acquire_owned(){let app=app.clone();let mut stop=stop.clone();tokio::spawn(async move{
                    let _permit=permit;let mut client=String::new();
                    let callback=|req:&Request,response:Response|->Result<Response,ErrorResponse>{
                        let origin=req.headers().get("Origin").and_then(|h|h.to_str().ok());
                        let trusted=origin.is_none()||origin==Some("https://discord.com");
                        let params=url::form_urlencoded::parse(req.uri().query().unwrap_or_default().as_bytes()).collect::<std::collections::HashMap<_,_>>();
                        client=params.get("client_id").map(|s|s.to_string()).unwrap_or_default();
                        if !trusted||!valid_client(&client){return Err(tokio_tungstenite::tungstenite::http::Response::builder().status(403).body(Some("Rejected RPC connection".into())).unwrap())}Ok(response)
                    };
                    let socket=tokio::time::timeout(Duration::from_secs(5),accept_hdr_async_with_config(stream,callback,Some(WebSocketConfig::default().max_message_size(Some(LIMIT)).max_frame_size(Some(LIMIT))))).await;
                    if let Ok(Ok(mut socket))=socket{
                        let id=NEXT_ID.fetch_add(1,Ordering::Relaxed);let _=socket.send(Message::Text(ready().to_string().into())).await;
                        loop{tokio::select!{_=stop.changed()=>break,message=socket.next()=>{match message{Some(Ok(Message::Text(text))) if text.len()<=LIMIT=>{if let Ok(data)=serde_json::from_str(&text){let response=request(&app,&client,id,data);if socket.send(Message::Text(response.to_string().into())).await.is_err(){break}}else{break}},Some(Ok(Message::Ping(data)))=>{let _=socket.send(Message::Pong(data)).await;},_=>break}}}}
                        relay(&app,json!({"activity":null,"socketId":id.to_string()}));
                    }
                });}}}}}}));
                break;
            }
        }
        Ok(service)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn packet_decoder_handles_fragmentation() {
        let (mut a, mut b) = tokio::io::duplex(128);
        let task = tokio::spawn(async move {
            let encoded =
                serde_json::to_vec(&json!({"client_id":"123456789012345678","v":1})).unwrap();
            let mut bytes = vec![];
            bytes.extend(0u32.to_le_bytes());
            bytes.extend((encoded.len() as u32).to_le_bytes());
            bytes.extend(encoded);
            for byte in bytes {
                a.write_all(&[byte]).await.unwrap();
                tokio::task::yield_now().await;
            }
        });
        let (op, v) = read_packet(&mut b).await.unwrap();
        assert_eq!(op, 0);
        assert!(valid_client(v["client_id"].as_str().unwrap()));
        task.await.unwrap();
    }
    #[tokio::test]
    async fn oversized_frame_rejected_before_allocation() {
        let (mut a, mut b) = tokio::io::duplex(8);
        a.write_all(&[1, 0, 0, 0, 255, 255, 255, 127])
            .await
            .unwrap();
        assert!(read_packet(&mut b).await.is_err());
    }
}
