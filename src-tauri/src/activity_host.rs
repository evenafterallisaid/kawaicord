use crate::config::Config;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;

#[derive(Clone)]
pub struct ActivityHost {
    pub config: Arc<Mutex<Config>>,
    pub changed: Arc<Notify>,
    emit: Arc<dyn Fn(Value) + Send + Sync>,
}
impl ActivityHost {
    pub fn new(
        config: Arc<Mutex<Config>>,
        changed: Arc<Notify>,
        emit: impl Fn(Value) + Send + Sync + 'static,
    ) -> Self {
        Self {
            config,
            changed,
            emit: Arc::new(emit),
        }
    }
    pub fn emit(&self, event: Value) {
        (self.emit)(event);
    }
}
