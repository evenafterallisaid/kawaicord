//! spotify's local automation interfaces. no shell, spotify patch, or account token.
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(
    tag = "action",
    rename_all = "lowercase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum Request {
    State,
    Play { uri: String },
    Seek { position_ms: u64, uri: String },
    Resume { uri: String },
    Pause { uri: String },
}
#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlayerState {
    uri: String,
    playing: bool,
    position_ms: u64,
}
fn track(value: &str) -> Result<(), String> {
    let id = value.strip_prefix("spotify:track:").unwrap_or_default();
    if id.len() == 22 && id.bytes().all(|v| v.is_ascii_alphanumeric()) {
        Ok(())
    } else {
        Err("Native Spotify playback accepts track URIs only.".into())
    }
}
#[cfg(any(
    target_os = "linux",
    all(target_os = "macos", feature = "native"),
    test
))]
fn normalize_uri(value: &str) -> String {
    let value = value.trim();
    if track(value).is_ok() {
        return value.into();
    }
    if let Ok(url) = url::Url::parse(value) {
        if url.scheme() == "https" && url.host_str() == Some("open.spotify.com") {
            if let Some(id) = url.path().strip_prefix("/track/") {
                let uri = format!("spotify:track:{id}");
                if track(&uri).is_ok() {
                    return uri;
                }
            }
        }
    }
    String::new()
}
pub async fn request(enabled: bool, request: Request) -> Result<PlayerState, String> {
    if !enabled {
        return Err("Native Spotify control is disabled.".into());
    }
    match &request {
        Request::Play { uri } | Request::Resume { uri } | Request::Pause { uri } => track(uri)?,
        Request::Seek { uri, position_ms } => {
            track(uri)?;
            if *position_ms > 3_600_000 {
                return Err("Spotify seek position is out of range.".into());
            }
        }
        Request::State => {}
    }
    // serialize local reads and changes, including changes from the settings report.
    static LOCK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
    let _guard = LOCK.lock().await;
    platform(request).await
}

#[cfg(all(target_os = "macos", feature = "native"))]
async fn platform(request: Request) -> Result<PlayerState, String> {
    tokio::task::spawn_blocking(move || objc2::rc::autoreleasepool(|_| macos::run(request)))
        .await
        .map_err(|e| e.to_string())?
}
#[cfg(all(target_os = "macos", feature = "native"))]
mod macos {
    use super::*;
    use objc2::rc::Retained;
    use objc2_foundation::{
        NSAppleEventDescriptor as Descriptor, NSAppleEventSendOptions, NSString,
    };
    fn code(value: &[u8; 4]) -> u32 {
        u32::from_be_bytes(*value)
    }
    enum Error {
        Code(i32),
        Property,
    }
    fn property(
        name: &[u8; 4],
        container: Option<&Descriptor>,
    ) -> Result<Retained<Descriptor>, Error> {
        let record = Descriptor::recordDescriptor();
        record.setDescriptor_forKeyword(
            &Descriptor::descriptorWithTypeCode(code(b"prop")),
            code(b"want"),
        );
        record.setDescriptor_forKeyword(
            &Descriptor::descriptorWithEnumCode(code(b"prop")),
            code(b"form"),
        );
        record.setDescriptor_forKeyword(
            &Descriptor::descriptorWithTypeCode(code(name)),
            code(b"seld"),
        );
        record.setDescriptor_forKeyword(
            container.unwrap_or(&Descriptor::nullDescriptor()),
            code(b"from"),
        );
        record
            .coerceToDescriptorType(code(b"obj "))
            .ok_or(Error::Property)
    }
    fn event(
        class: &[u8; 4],
        id: &[u8; 4],
        object: Option<&Descriptor>,
        data: Option<&Descriptor>,
    ) -> Result<Option<Retained<Descriptor>>, Error> {
        let target =
            Descriptor::descriptorWithBundleIdentifier(&NSString::from_str("com.spotify.client"));
        let event =
            Descriptor::appleEventWithEventClass_eventID_targetDescriptor_returnID_transactionID(
                code(class),
                code(id),
                Some(&target),
                -1,
                0,
            );
        if let Some(object) = object {
            event.setParamDescriptor_forKeyword(object, code(b"----"));
        }
        if let Some(data) = data {
            event.setParamDescriptor_forKeyword(data, code(b"data"));
        }
        let reply = event
            .sendEventWithOptions_timeout_error(
                NSAppleEventSendOptions::WaitForReply | NSAppleEventSendOptions::NeverInteract,
                3.0,
            )
            .map_err(|e| Error::Code(e.code() as i32))?;
        if let Some(number) = reply.paramDescriptorForKeyword(code(b"errn")) {
            if number.int32Value() != 0 {
                return Err(Error::Code(number.int32Value()));
            }
        }
        Ok(reply.paramDescriptorForKeyword(code(b"----")))
    }
    fn error(error: Error) -> String {
        let number = match error {
            Error::Code(number) => number,
            Error::Property => return "Could not create a Spotify property request.".into(),
        };
        match number {
            -1743 | -1744 => "Allow Kawaicord to control Spotify in System Settings > Privacy & Security > Automation, then retry.".into(),
            -600 | -609 => "Open the Spotify desktop app, then retry native control.".into(),
            -1712 => "Spotify did not respond to native control in time. Retry after checking Spotify.".into(),
            _ => format!("Spotify native control failed ({number})."),
        }
    }
    fn get(
        name: &[u8; 4],
        container: Option<&Descriptor>,
    ) -> Result<Option<Retained<Descriptor>>, Error> {
        {
            let object = property(name, container)?;
            event(b"core", b"getd", Some(&object), None)
        }
    }
    fn uri() -> Result<String, Error> {
        let current = property(b"pTrk", None)?;
        match get(b"spur", Some(&current)) {
            Ok(value) => Ok(value
                .and_then(|v| v.stringValue())
                .map(|v| normalize_uri(&v.to_string()))
                .unwrap_or_default()),
            Err(Error::Code(-1728)) => Ok(String::new()),
            Err(error) => Err(error),
        }
    }
    pub fn run(request: Request) -> Result<PlayerState, String> {
        run_inner(request).map_err(error)
    }
    fn run_inner(request: Request) -> Result<PlayerState, Error> {
        match request {
            Request::Play { uri } => {
                event(
                    b"spfy",
                    b"PCtx",
                    Some(&Descriptor::descriptorWithString(&NSString::from_str(&uri))),
                    None,
                )?;
            }
            Request::Seek {
                uri: expected,
                position_ms,
            } => {
                if uri()? == expected {
                    let object = property(b"pPos", None)?;
                    event(
                        b"core",
                        b"setd",
                        Some(&object),
                        Some(&Descriptor::descriptorWithDouble(
                            position_ms as f64 / 1000.0,
                        )),
                    )?;
                }
            }
            Request::Resume { uri: expected } => {
                if uri()? == expected {
                    event(b"spfy", b"Play", None, None)?;
                }
            }
            Request::Pause { uri: expected } => {
                if uri()? == expected {
                    event(b"spfy", b"Paus", None, None)?;
                }
            }
            Request::State => {}
        }
        let playing = get(b"pPlS", None)?.is_some_and(|v| v.enumCodeValue() == code(b"kPSP"));
        let position = get(b"pPos", None)?.map(|v| v.doubleValue()).unwrap_or(0.0);
        Ok(PlayerState {
            uri: uri()?,
            playing,
            position_ms: if position.is_finite() {
                (position.max(0.0) * 1000.0) as u64
            } else {
                0
            },
        })
    }
}

#[cfg(target_os = "linux")]
async fn platform(request: Request) -> Result<PlayerState, String> {
    tokio::time::timeout(std::time::Duration::from_secs(4), linux::run(request))
        .await
        .map_err(|_| "Spotify's MPRIS interface did not respond in time.".to_string())?
}
#[cfg(target_os = "linux")]
mod linux {
    use super::*;
    use std::collections::HashMap;
    use zbus::zvariant::{OwnedObjectPath, OwnedValue};
    pub async fn run(request: Request) -> Result<PlayerState, String> {
        static CONNECTION: tokio::sync::OnceCell<zbus::Connection> =
            tokio::sync::OnceCell::const_new();
        let connection = CONNECTION
            .get_or_try_init(zbus::Connection::session)
            .await
            .map_err(|_| "Could not connect to the desktop session bus.".to_string())?;
        let player: zbus::Proxy<'_> = zbus::proxy::Builder::new(connection)
            .destination("org.mpris.MediaPlayer2.spotify")
            .map_err(|e| e.to_string())?
            .path("/org/mpris/MediaPlayer2")
            .map_err(|e| e.to_string())?
            .interface("org.mpris.MediaPlayer2.Player")
            .map_err(|e| e.to_string())?
            .cache_properties(zbus::proxy::CacheProperties::No)
            .build()
            .await
            .map_err(|e| e.to_string())?;
        let metadata = || player.get_property::<HashMap<String, OwnedValue>>("Metadata");
        let uri = |m: &HashMap<String, OwnedValue>| {
            m.get("xesam:url")
                .and_then(|v| <&str>::try_from(v).ok())
                .map(normalize_uri)
                .unwrap_or_default()
        };
        let resume = matches!(request, Request::Resume { .. });
        let result: zbus::Result<()> = match request {
            Request::Play { uri } => player.call("OpenUri", &(uri,)).await,
            Request::State => Ok(()),
            Request::Seek {
                uri: expected,
                position_ms,
            } => {
                let m = metadata().await.map_err(|e| e.to_string())?;
                if uri(&m) == expected {
                    let id = m
                        .get("mpris:trackid")
                        .and_then(|v| v.try_clone().ok())
                        .and_then(|v| OwnedObjectPath::try_from(v).ok())
                        .ok_or("Spotify did not provide a current MPRIS track identifier.")?;
                    player
                        .call("SetPosition", &(id, (position_ms * 1000) as i64))
                        .await
                } else {
                    Ok(())
                }
            }
            Request::Resume { uri: expected } | Request::Pause { uri: expected } => {
                let m = metadata().await.map_err(|e| e.to_string())?;
                if uri(&m) == expected {
                    player
                        .call(if resume { "Play" } else { "Pause" }, &())
                        .await
                } else {
                    Ok(())
                }
            }
        };
        result.map_err(|_| "Spotify native control failed. Open Spotify and check its MPRIS support, then retry.".to_string())?;
        let m = metadata().await.map_err(|e| e.to_string())?;
        let playing: String = player
            .get_property("PlaybackStatus")
            .await
            .map_err(|e| e.to_string())?;
        let position: i64 = player
            .get_property("Position")
            .await
            .map_err(|e| e.to_string())?;
        Ok(PlayerState {
            uri: uri(&m),
            playing: playing == "Playing",
            position_ms: position.max(0) as u64 / 1000,
        })
    }
}
#[cfg(not(any(target_os = "linux", all(target_os = "macos", feature = "native"))))]
async fn platform(_: Request) -> Result<PlayerState, String> {
    Err("Native Spotify control is available on macOS and Linux. Use the companion on this platform.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_valid_tracks_can_be_addressed() {
        assert!(track("spotify:track:0123456789abcdefghijkl").is_ok());
        for value in [
            "spotify:",
            "spotify:track:x\"",
            "https://evil.test/track/0123456789abcdefghijkl",
        ] {
            assert!(track(value).is_err());
            assert!(normalize_uri(value).is_empty());
        }
        assert_eq!(
            normalize_uri("https://open.spotify.com/track/0123456789abcdefghijkl?si=test"),
            "spotify:track:0123456789abcdefghijkl"
        );
    }
    #[tokio::test]
    async fn disabled_and_invalid_requests_never_contact_spotify() {
        assert!(request(false, Request::State)
            .await
            .unwrap_err()
            .contains("disabled"));
        assert!(request(
            true,
            Request::Play {
                uri: "spotify:app:bad".into()
            }
        )
        .await
        .is_err());
        assert!(request(
            true,
            Request::Seek {
                uri: "spotify:track:0123456789abcdefghijkl".into(),
                position_ms: u64::MAX
            }
        )
        .await
        .is_err());
    }

    #[test]
    fn native_commands_use_the_typed_webview_wire_format() {
        let r: Request = serde_json::from_value(serde_json::json!({"action":"seek","uri":"spotify:track:0123456789abcdefghijkl","positionMs":12500})).unwrap();
        assert!(matches!(
            r,
            Request::Seek {
                position_ms: 12500,
                ..
            }
        ));
        assert!(serde_json::from_value::<Request>(serde_json::json!({"action":"play","uri":"spotify:track:0123456789abcdefghijkl","script":"anything"})).is_err());
    }
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn mpris_calls_use_microseconds_and_do_not_seek_or_pause_a_replacement_track() {
        // CI creates a private dbus-run-session, never a user's real desktop bus.
        if std::env::var("KAWAICORD_MPRIS_TEST_BUS").as_deref() != Ok("1") {
            return;
        }
        use std::{
            collections::HashMap,
            sync::{Arc, Mutex},
        };
        use zbus::zvariant::{OwnedObjectPath, OwnedValue, Str};
        #[derive(Default)]
        struct MockState {
            uri: String,
            playing: bool,
            position: i64,
        }
        struct Player(Arc<Mutex<MockState>>);
        #[zbus::interface(name = "org.mpris.MediaPlayer2.Player")]
        impl Player {
            fn open_uri(&self, uri: String) {
                let mut s = self.0.lock().unwrap();
                s.uri = uri;
                s.playing = true;
            }
            fn set_position(&self, track: OwnedObjectPath, position: i64) {
                assert_eq!(track.as_str(), "/spotify/current");
                self.0.lock().unwrap().position = position;
            }
            fn pause(&self) {
                self.0.lock().unwrap().playing = false;
            }
            fn play(&self) {
                self.0.lock().unwrap().playing = true;
            }
            #[zbus(property)]
            fn metadata(&self) -> HashMap<String, OwnedValue> {
                HashMap::from([
                    (
                        "xesam:url".into(),
                        OwnedValue::from(Str::from(self.0.lock().unwrap().uri.clone())),
                    ),
                    (
                        "mpris:trackid".into(),
                        OwnedValue::from(
                            OwnedObjectPath::try_from("/spotify/current")
                                .unwrap()
                                .into_inner(),
                        ),
                    ),
                ])
            }
            #[zbus(property)]
            fn playback_status(&self) -> String {
                if self.0.lock().unwrap().playing {
                    "Playing"
                } else {
                    "Paused"
                }
                .into()
            }
            #[zbus(property)]
            fn position(&self) -> i64 {
                self.0.lock().unwrap().position
            }
        }
        let shared = Arc::new(Mutex::new(MockState::default()));
        let _server = zbus::connection::Builder::session()
            .unwrap()
            .name("org.mpris.MediaPlayer2.spotify")
            .unwrap()
            .serve_at("/org/mpris/MediaPlayer2", Player(shared.clone()))
            .unwrap()
            .build()
            .await
            .unwrap();
        let uri = "spotify:track:0123456789abcdefghijkl".to_string();
        assert!(
            request(true, Request::Play { uri: uri.clone() })
                .await
                .unwrap()
                .playing
        );
        assert_eq!(
            request(
                true,
                Request::Seek {
                    uri: uri.clone(),
                    position_ms: 12_345
                }
            )
            .await
            .unwrap()
            .position_ms,
            12_345
        );
        assert_eq!(shared.lock().unwrap().position, 12_345_000);
        let other = "spotify:track:1123456789abcdefghijkl".to_string();
        request(
            true,
            Request::Seek {
                uri: other.clone(),
                position_ms: 1,
            },
        )
        .await
        .unwrap();
        assert_eq!(shared.lock().unwrap().position, 12_345_000);
        assert!(
            request(true, Request::Pause { uri: other })
                .await
                .unwrap()
                .playing
        );
        assert!(
            !request(true, Request::Pause { uri: uri.clone() })
                .await
                .unwrap()
                .playing
        );
        assert!(
            request(true, Request::Resume { uri })
                .await
                .unwrap()
                .playing
        );
    }
}
