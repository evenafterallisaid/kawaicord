use crate::cloud_client::{Request, Response};
use tauri::WebviewWindow;
#[tauri::command]
pub async fn cloud_request(window: WebviewWindow, request: Request) -> Result<Response, String> {
    if !super::trusted(&window) {
        return Err("Untrusted renderer".into());
    }
    let origin = window
        .url()
        .map_err(|error| error.to_string())?
        .origin()
        .ascii_serialization();
    crate::cloud_client::perform(&origin, request).await
}
