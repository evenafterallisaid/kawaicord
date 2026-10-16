use serde_json::{json, Value};
use tauri::{AppHandle, Manager, WebviewWindow};
async fn evaluate(window: &WebviewWindow, script: &str) -> Result<Value, String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let sender = std::sync::Mutex::new(Some(tx));
    window
        .eval_with_callback(format!("(()=>{{try{{return {{value:({script})??null}}}}catch(error){{return {{error:String(error)}}}}}})()"), move |value| {
            if let Some(tx) = sender.lock().unwrap().take() {
                let _ = tx.send(value);
            }
        })
        .map_err(|e| e.to_string())?;
    let value = tokio::time::timeout(std::time::Duration::from_secs(10), rx)
        .await
        .map_err(|_| "Script result timed out")?
        .map_err(|e| e.to_string())?;
    let result: Value =
        serde_json::from_str(&value).map_err(|e| format!("Invalid script result: {e}: {value}"))?;
    if let Some(error) = result.get("error") {
        return Err(format!("Script failed in {}: {error}", window.label()));
    }
    Ok(result["value"].clone())
}
pub async fn run(app: AppHandle, main: WebviewWindow) {
    let result = check(&app, &main).await;
    let state = app.state::<super::AppState>();
    let report = match result {
        Ok(report) => report,
        Err(error) => json!({"ok":false,"error":error}),
    };
    let _ = super::config::save_json(&state.profile.join("integration.json"), &report);
    let code = if report["ok"] == true { 0 } else { 1 };
    super::clean_exit(&app);
    app.exit(code);
}
async fn check(app: &AppHandle, main: &WebviewWindow) -> Result<Value, String> {
    let log = |message: &str| app.state::<super::AppState>().log(message);
    let id_a = format!("smoke-a-{}", std::process::id());
    let id_b = format!("smoke-b-{}", std::process::id());
    for (id, name) in [(&id_a, "isolated a"), (&id_b, "isolated b")] {
        log(&format!("Integration: opening {id}"));
        super::instances::open_instance(
            app.clone(),
            main.clone(),
            id.to_owned(),
            name.into(),
            true,
            "discord.com".into(),
            false,
            false,
            "detached".into(),
        )
        .await?;
        log(&format!("Integration: opened {id}"));
    }
    for _ in 0..60 {
        let ready = app
            .state::<super::instances::Instances>()
            .0
            .lock()
            .unwrap()
            .values()
            .filter(|i| i.ready)
            .count();
        if ready == 2 {
            break;
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    let a = app
        .get_webview_window(&format!("instance-{id_a}"))
        .ok_or("Instance A missing")?;
    let b = app
        .get_webview_window(&format!("instance-{id_b}"))
        .ok_or("Instance B missing")?;
    log(&format!("Integration: A {:?}, B {:?}", a.url(), b.url()));
    let details = evaluate(&a,"({href:location.href,storage:typeof localStorage,title:document.title,ready:document.readyState,text:document.body?.textContent?.slice(0,200),bridge:typeof window.__TAURI_INTERNALS__,shelter:!!window.shelter})").await?;
    log(&format!("Integration: A document {details}"));
    evaluate(
        &a,
        "(()=>{const frame=document.createElement('iframe');frame.hidden=true;document.body.append(frame);frame.contentWindow.localStorage.setItem('__kawaicord_isolation_probe','alpha');frame.remove();return true})()",
    )
    .await?;
    let isolation = evaluate(
        &b,
        "(()=>{const frame=document.createElement('iframe');frame.hidden=true;document.body.append(frame);const clean=frame.contentWindow.localStorage.getItem('__kawaicord_isolation_probe')===null;frame.remove();return clean})()",
    )
    .await?
        == true;
    if !isolation {
        return Err("Instance storage was shared".into());
    }
    evaluate(main,"(()=>{window.__kawaicordUiProbeError=null;shelter.solid.createRoot(()=>{try{const pane=window.__kawaicordSettingsPage();document.body.append(pane)}catch(e){window.__kawaicordUiProbeError=String(e)}});fetch('https://cloud.equicord.org/v1/oauth/settings').then(r=>r.json()).then(v=>window.__kawaicordCloudProbe=!!v.clientId&&!!v.redirectUri).catch(e=>window.__kawaicordCloudProbe=String(e));return true})()").await?;
    tokio::time::sleep(std::time::Duration::from_secs(6)).await;
    let ui=evaluate(main,"document.querySelector('#kawaicord-settings')?.querySelectorAll('input[type=checkbox]').length>=9").await?;
    let button_text_fits = evaluate(main,"Array.from(document.querySelectorAll('#kawaicord-settings button')).filter(b=>b.getClientRects().length>0).every(b=>b.scrollWidth<=b.clientWidth+1)").await?;
    let cloud = evaluate(main, "window.__kawaicordCloudProbe===true").await?;
    let helper = evaluate(
        main,
        "typeof window.VencordNative?.pluginHelpers?.MultiInstance?.openInstance==='function'",
    )
    .await?;
    if ui != true {
        return Err(format!("Discord settings did not render: {}",evaluate(main,"window.__kawaicordUiProbeError||document.querySelector('#kawaicord-settings')?.textContent||'missing'").await?));
    }
    if cloud != true {
        return Err(format!(
            "OAuth configuration bridge failed: {}",
            evaluate(main, "window.__kawaicordCloudProbe??'pending'").await?
        ));
    }
    if button_text_fits != true {
        return Err("Settings button labels overflowed their controls".into());
    }
    if helper != true {
        return Err("Multi-instance bridge missing".into());
    }
    super::instances::close_all_instances(app.clone(), main.clone()).await?;
    for id in [id_a, id_b] {
        super::instances::clear_instance_session(app.clone(), main.clone(), id).await?;
    }
    Ok(
        json!({"ok":true,"separateSessionStorage":true,"discordSettingsRendered":true,"buttonLabelsFit":true,"oauthConfigurationLoaded":true,"nativeInstanceHelper":true}),
    )
}
