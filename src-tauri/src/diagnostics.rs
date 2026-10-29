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
async fn instance_ready(app: &AppHandle, id: &str) -> Result<WebviewWindow, String> {
    let label = format!("instance-{id}");
    for _ in 0..60 {
        let ready = app
            .state::<super::instances::Instances>()
            .0
            .lock()
            .unwrap()
            .get(&label)
            .is_some_and(|instance| instance.ready);
        if ready {
            return app
                .get_webview_window(&label)
                .ok_or_else(|| format!("Instance {id} disappeared"));
        }
        tokio::time::sleep(std::time::Duration::from_secs(1)).await;
    }
    Err(format!("Instance {id} did not finish loading"))
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
    let a = instance_ready(app, &id_a).await?;
    let b = instance_ready(app, &id_b).await?;
    evaluate(
        &a,
        "(()=>{document.cookie='__kawaicord_isolation_cookie=alpha;Path=/;Secure;SameSite=Lax';const frame=document.createElement('iframe');frame.hidden=true;document.body.append(frame);frame.contentWindow.localStorage.setItem('__kawaicord_isolation_probe','alpha');frame.remove();return true})()",
    )
    .await?;
    let isolation = evaluate(
        &b,
        "(()=>{const frame=document.createElement('iframe');frame.hidden=true;document.body.append(frame);const clean=frame.contentWindow.localStorage.getItem('__kawaicord_isolation_probe')===null;frame.remove();return clean&&!document.cookie.split(';').some(cookie=>cookie.trim().startsWith('__kawaicord_isolation_cookie='))})()",
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
    for id in [&id_a, &id_b] {
        super::instances::clear_instance_session(app.clone(), main.clone(), id.to_owned()).await?;
    }
    super::instances::open_instance(
        app.clone(),
        main.clone(),
        id_a.clone(),
        "cleared session".into(),
        true,
        "discord.com".into(),
        false,
        false,
        "detached".into(),
    )
    .await?;
    let reopened = instance_ready(app, &id_a).await?;
    let cleared = evaluate(&reopened,"(()=>{const frame=document.createElement('iframe');frame.hidden=true;document.body.append(frame);const clean=frame.contentWindow.localStorage.getItem('__kawaicord_isolation_probe')===null;frame.remove();return clean&&!document.cookie.split(';').some(cookie=>cookie.trim().startsWith('__kawaicord_isolation_cookie='))})()").await?;
    if cleared != true {
        return Err("Cleared instance login data returned after reopening".into());
    }
    super::instances::close_instance(app.clone(), main.clone(), id_a.clone()).await?;
    super::instances::clear_instance_session(app.clone(), main.clone(), id_a.clone()).await?;
    for (id, name) in [(&id_a, "temporary a"), (&id_b, "temporary b")] {
        super::instances::open_instance(
            app.clone(),
            main.clone(),
            id.to_owned(),
            name.into(),
            false,
            "discord.com".into(),
            false,
            false,
            "detached".into(),
        )
        .await?;
    }
    let temporary_a = instance_ready(app, &id_a).await?;
    let temporary_b = instance_ready(app, &id_b).await?;
    evaluate(&temporary_a, "(()=>{document.cookie='__kawaicord_isolation_cookie=alpha;Path=/;Secure;SameSite=Lax';const frame=document.createElement('iframe');frame.hidden=true;document.body.append(frame);frame.contentWindow.localStorage.setItem('__kawaicord_isolation_probe','alpha');frame.remove();return true})()").await?;
    let isolated = evaluate(&temporary_b, "(()=>{const frame=document.createElement('iframe');frame.hidden=true;document.body.append(frame);const clean=frame.contentWindow.localStorage.getItem('__kawaicord_isolation_probe')===null;frame.remove();return clean&&!document.cookie.split(';').some(cookie=>cookie.trim().startsWith('__kawaicord_isolation_cookie='))})()").await?;
    if isolated != true {
        return Err("Temporary instance sessions were shared".into());
    }
    super::instances::close_all_instances(app.clone(), main.clone()).await?;
    super::instances::open_instance(
        app.clone(),
        main.clone(),
        id_a.clone(),
        "reopened temporary session".into(),
        false,
        "discord.com".into(),
        false,
        false,
        "detached".into(),
    )
    .await?;
    let temporary = instance_ready(app, &id_a).await?;
    let fresh = evaluate(&temporary, "(()=>{const frame=document.createElement('iframe');frame.hidden=true;document.body.append(frame);const clean=frame.contentWindow.localStorage.getItem('__kawaicord_isolation_probe')===null;frame.remove();return clean&&!document.cookie.split(';').some(cookie=>cookie.trim().startsWith('__kawaicord_isolation_cookie='))})()").await?;
    if fresh != true {
        return Err("Temporary instance restored a closed session".into());
    }
    super::instances::close_all_instances(app.clone(), main.clone()).await?;
    Ok(
        json!({"ok":true,"separateSessionStorage":true,"clearedSessionStayedCleared":true,"temporarySessionsIsolated":true,"temporarySessionNotRestored":true,"discordSettingsRendered":true,"buttonLabelsFit":true,"oauthConfigurationLoaded":true,"nativeInstanceHelper":true}),
    )
}

pub async fn run_media(app: AppHandle, main: WebviewWindow) {
    let result = async {
        evaluate(&main, "(window.__kawaicordTestAudio().then(report=>window.__kawaicordMediaResult=report),true)").await?;
        for _ in 0..25 {
            let value = evaluate(&main,"window.__kawaicordMediaResult??null").await?;
            if !value.is_null() { return Ok::<Value,String>(value); }
            tokio::time::sleep(std::time::Duration::from_secs(1)).await;
        }
        Err("Media test timed out".into())
    }.await;
    let report = result.unwrap_or_else(|error| json!({"ok":false,"error":error}));
    let _ = super::config::save_json(
        &app.state::<super::AppState>().profile.join("media.json"),
        &report,
    );
    println!("{report}");
    super::clean_exit(&app);
    app.exit(if report["ok"] == true { 0 } else { 1 });
}
