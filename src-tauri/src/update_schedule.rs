use std::{future::Future, time::Duration};
use tokio::{sync::watch, time::sleep};

pub async fn run<F: Future<Output = ()>>(
    mut enabled: watch::Receiver<bool>,
    mut check: impl FnMut() -> F,
) {
    tokio::select! {
        _ = sleep(Duration::from_secs(60)) => {}
        _ = enabled.wait_for(|_| false) => return,
    }
    while enabled.wait_for(|value| *value).await.is_ok() {
        check().await;
        tokio::select! {
            _ = sleep(Duration::from_secs(6 * 3600)) => {}
            result = enabled.wait_for(|value| !*value) => {
                if result.is_err() {
                    return;
                }
            }
        }
    }
}
