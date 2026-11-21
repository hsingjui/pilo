use serde::Serialize;
use serde_json::Value;

pub trait HostEvents: Send + Sync {
    fn emit(&self, name: &str, payload: Value) -> Result<(), String>;

    fn emit_runtime(&self, event: super::events::RuntimeEventEnvelope) -> Result<(), String> {
        self.emit(
            super::events::RUNTIME_EVENT_NAME,
            serde_json::to_value(event).map_err(|error| error.to_string())?,
        )
    }
}

impl dyn HostEvents + '_ {
    pub(crate) fn emit_serialized(
        &self,
        name: &str,
        payload: impl Serialize,
    ) -> Result<(), String> {
        self.emit(
            name,
            serde_json::to_value(payload).map_err(|error| error.to_string())?,
        )
    }
}

#[cfg(test)]
#[derive(Default)]
pub(crate) struct RecordingEvents {
    pub(crate) events: std::sync::Mutex<Vec<(String, Value)>>,
    pub(crate) fail: std::sync::atomic::AtomicBool,
}

#[cfg(test)]
impl HostEvents for RecordingEvents {
    fn emit(&self, name: &str, payload: Value) -> Result<(), String> {
        if self.fail.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("event delivery failed".to_owned());
        }
        self.events.lock().unwrap().push((name.to_owned(), payload));
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct InvalidPayload;

    impl Serialize for InvalidPayload {
        fn serialize<S: serde::Serializer>(&self, _serializer: S) -> Result<S::Ok, S::Error> {
            Err(serde::ser::Error::custom("invalid payload"))
        }
    }

    #[test]
    fn serialized_events_preserve_null_and_do_not_deliver_invalid_payloads() {
        let recording = RecordingEvents::default();
        let events: &dyn HostEvents = &recording;
        events.emit_serialized("empty", ()).unwrap();
        assert_eq!(
            events.emit_serialized("invalid", InvalidPayload),
            Err("invalid payload".into())
        );
        assert_eq!(
            *recording.events.lock().unwrap(),
            vec![("empty".into(), Value::Null)]
        );
    }
}
