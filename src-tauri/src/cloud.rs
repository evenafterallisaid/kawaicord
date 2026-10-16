use serde::{Deserialize, Serialize};
use tauri::WebviewWindow;
#[derive(Deserialize)]
pub struct Request {
    url: String,
    method: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
#[derive(Serialize)]
pub struct Response {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
fn allowed(url: &url::Url) -> bool {
    url.scheme() == "https"
        && url.port_or_known_default() == Some(443)
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(
            url.host_str(),
            Some("cloud.equicord.org" | "api.vencord.dev")
        )
}
#[tauri::command]
pub async fn cloud_request(window: WebviewWindow, request: Request) -> Result<Response, String> {
    if !super::trusted(&window) {
        return Err("Untrusted renderer".into());
    }
    let url = url::Url::parse(&request.url).map_err(|e| e.to_string())?;
    if !allowed(&url) || request.body.len() > 8 * 1024 * 1024 || request.headers.len() > 64 {
        return Err("Unsupported cloud request".into());
    }
    let method =
        reqwest::Method::from_bytes(request.method.as_bytes()).map_err(|e| e.to_string())?;
    if !matches!(
        method.as_str(),
        "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"
    ) {
        return Err("Unsupported cloud method".into());
    }
    let client = reqwest::Client::builder()
        .user_agent(concat!("Kawaicord/", env!("CARGO_PKG_VERSION")))
        .timeout(std::time::Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if allowed(attempt.url()) {
                if attempt.previous().len() < 5 {
                    attempt.follow()
                } else {
                    attempt.error("Too many cloud redirects")
                }
            } else {
                attempt.error("Untrusted cloud redirect")
            }
        }))
        .build()
        .map_err(|e| e.to_string())?;
    let mut builder = client.request(method, url);
    for (name, value) in request.headers {
        if name.len() > 128 || value.len() > 8192 {
            return Err("Oversized cloud header".into());
        }
        if !matches!(
            name.to_ascii_lowercase().as_str(),
            "host" | "cookie" | "connection" | "content-length" | "origin"
        ) {
            builder = builder.header(&name, value);
        }
    }
    let origin = window
        .url()
        .map_err(|e| e.to_string())?
        .origin()
        .ascii_serialization();
    let mut response = builder
        .header("Origin", origin)
        .body(request.body)
        .send()
        .await
        .map_err(|e| format!("Cloud service request failed: {e}"))?;
    let status = response.status().as_u16();
    let headers = response
        .headers()
        .iter()
        .filter(|(key, _)| {
            !matches!(
                key.as_str(),
                "set-cookie" | "content-encoding" | "content-length"
            )
        })
        .filter_map(|(key, value)| Some((key.to_string(), value.to_str().ok()?.to_owned())))
        .collect();
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
        if body.len() + chunk.len() > 8 * 1024 * 1024 {
            return Err("Cloud response exceeds size limit".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Response {
        status,
        headers,
        body,
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bridge_is_limited_to_official_cloud_services() {
        for u in [
            "https://cloud.equicord.org/v1/oauth/settings",
            "https://api.vencord.dev/v1/settings",
        ] {
            assert!(allowed(&url::Url::parse(u).unwrap()))
        }
        for u in [
            "http://cloud.equicord.org/",
            "https://cloud.equicord.org.evil.test/",
            "https://discord.com/api/users/@me",
            "https://localhost/",
            "https://cloud.equicord.org:8443/",
            "https://user@cloud.equicord.org/",
        ] {
            assert!(!allowed(&url::Url::parse(u).unwrap()))
        }
    }
}
