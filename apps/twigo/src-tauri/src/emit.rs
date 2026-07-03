use serde::Serialize;
use tauri::Emitter;

pub(crate) trait Emit: Clone + Send + Sync + 'static {
    fn emit_event<T: Serialize + Clone>(&self, event: &str, payload: T);
}

impl Emit for tauri::AppHandle {
    fn emit_event<T: Serialize + Clone>(&self, event: &str, payload: T) {
        if let Err(e) = self.emit(event, payload) {
            tracing::warn!("failed to emit {event}: {e}");
        }
    }
}
