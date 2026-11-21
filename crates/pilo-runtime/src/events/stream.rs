use std::{
    collections::HashMap,
    sync::{Arc, Mutex, Weak},
};

use tokio::sync::watch;

use super::{EventReplay, SequencedRuntimeEvent};

/// Per-reader limits. Bytes count the serialized sequenced envelopes, not Arc overhead.
/// A zero limit drops every event and reports its sequence in a gap.
#[derive(Clone, Copy, Debug)]
pub struct EventQueueLimits {
    pub max_events: usize,
    pub max_bytes: usize,
}

#[derive(Debug)]
pub enum EventBatch {
    Events(Vec<Arc<SequencedRuntimeEvent>>),
    /// Inclusive range of events dropped for this reader.
    Gap {
        first_missed: u64,
        last_missed: u64,
    },
    Closed,
}

/// An independent, ordered reader that does not retain its Runtime.
pub struct EventStream {
    id: u64,
    registry: Weak<Mutex<StreamRegistry>>,
    queue: Arc<Mutex<StreamQueue>>,
    notifications: watch::Receiver<()>,
    start_sequence: u64,
}

#[derive(Default)]
pub(super) struct StreamRegistry {
    next_id: u64,
    readers: HashMap<u64, StreamSender>,
    closed: bool,
}

struct StreamSender {
    queue: Arc<Mutex<StreamQueue>>,
    notifications: watch::Sender<()>,
}

struct StreamQueue {
    buffer: EventReplay,
    limits: EventQueueLimits,
    gap: Option<(u64, u64)>,
    closed: bool,
}

impl StreamRegistry {
    pub(super) fn publish(&mut self, event: &Arc<SequencedRuntimeEvent>, bytes: usize) {
        for reader in self.readers.values() {
            let mut queue = reader
                .queue
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if queue.buffer.events.len() >= queue.limits.max_events
                || queue
                    .buffer
                    .bytes
                    .checked_add(bytes)
                    .is_none_or(|total| total > queue.limits.max_bytes)
            {
                let first = queue
                    .gap
                    .map(|gap| gap.0)
                    .or_else(|| queue.buffer.events.front().map(|(event, _)| event.sequence))
                    .unwrap_or(event.sequence);
                queue.buffer.clear();
                queue.gap = Some((first, event.sequence));
            } else {
                queue.buffer.bytes += bytes;
                queue.buffer.events.push_back((Arc::clone(event), bytes));
            }
            reader.notifications.send_replace(());
        }
    }

    pub(super) fn close(&mut self) {
        self.closed = true;
        for (_, reader) in self.readers.drain() {
            let mut queue = reader
                .queue
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            queue.closed = true;
            queue.buffer.clear();
            queue.gap = None;
            reader.notifications.send_replace(());
        }
    }
}

impl EventStream {
    pub(super) fn subscribe(
        registry: &Arc<Mutex<StreamRegistry>>,
        start_sequence: u64,
        limits: EventQueueLimits,
    ) -> Self {
        let mut state = registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.next_id += 1;
        let id = state.next_id;
        let queue = Arc::new(Mutex::new(StreamQueue {
            buffer: EventReplay::default(),
            limits,
            gap: None,
            closed: state.closed,
        }));
        let (notifications, receiver) = watch::channel(());
        if !state.closed {
            state.readers.insert(
                id,
                StreamSender {
                    queue: Arc::clone(&queue),
                    notifications,
                },
            );
        }
        Self {
            id,
            registry: Arc::downgrade(registry),
            queue,
            notifications: receiver,
            start_sequence,
        }
    }

    /// Latest sequence at subscription, captured under the publication lock.
    pub fn start_sequence(&self) -> u64 {
        self.start_sequence
    }

    /// Reads at most `max` events without waiting; None means an open, empty queue.
    /// A zero maximum returns an empty batch without consuming events or gaps.
    pub fn try_next_batch(&mut self, max: usize) -> Option<EventBatch> {
        let mut queue = self
            .queue
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if queue.closed {
            return Some(EventBatch::Closed);
        }
        if max == 0 {
            return Some(EventBatch::Events(Vec::new()));
        }
        if let Some((first_missed, last_missed)) = queue.gap.take() {
            return Some(EventBatch::Gap {
                first_missed,
                last_missed,
            });
        }
        if queue.buffer.events.is_empty() {
            return None;
        }
        let mut events = Vec::with_capacity(max.min(queue.buffer.events.len()));
        for _ in 0..max {
            let Some((event, bytes)) = queue.buffer.events.pop_front() else {
                break;
            };
            queue.buffer.bytes -= bytes;
            events.push(event);
        }
        Some(EventBatch::Events(events))
    }

    /// Waits for events, a gap, or closure. Cancelling this future consumes nothing.
    pub async fn next_batch(&mut self, max: usize) -> EventBatch {
        loop {
            if let Some(batch) = self.try_next_batch(max) {
                return batch;
            }
            if self.notifications.changed().await.is_err() {
                return EventBatch::Closed;
            }
        }
    }
}

impl Drop for EventStream {
    fn drop(&mut self) {
        if let Some(registry) = self.registry.upgrade() {
            registry
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .readers
                .remove(&self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        Runtime,
        events::{RuntimeEvent, RuntimeEventBus, RuntimeEventEnvelope},
        host_events::RecordingEvents,
        host_paths::HostPaths,
    };

    fn limits(max_events: usize) -> EventQueueLimits {
        EventQueueLimits {
            max_events,
            max_bytes: usize::MAX,
        }
    }

    fn send(bus: &RuntimeEventBus) {
        bus.send(RuntimeEventEnvelope::global(
            RuntimeEvent::ConfigurationChanged,
        ));
    }

    fn sequences(batch: EventBatch) -> Vec<u64> {
        match batch {
            EventBatch::Events(events) => events.iter().map(|event| event.sequence).collect(),
            other => panic!("expected events, got {other:?}"),
        }
    }

    fn runtime() -> Runtime {
        Runtime::new(
            HostPaths::for_test(std::path::PathBuf::new()),
            Arc::new(RecordingEvents::default()),
        )
    }

    fn pending_reader(
        mut stream: EventStream,
    ) -> (
        tokio::sync::oneshot::Receiver<()>,
        tokio::task::JoinHandle<EventBatch>,
    ) {
        use std::{future::Future, task::Poll};
        let (ready, waiting) = tokio::sync::oneshot::channel();
        let reader = tokio::spawn(async move {
            let pending = stream.next_batch(2);
            tokio::pin!(pending);
            std::future::poll_fn(|cx| {
                assert!(pending.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            ready.send(()).unwrap();
            pending.await
        });
        (waiting, reader)
    }

    #[test]
    fn stream_is_send_and_static() {
        fn assert_send_static<T: Send + 'static>() {}
        assert_send_static::<EventStream>();
    }

    #[test]
    fn independent_queues_work_with_web_disabled_and_unsubscribe_on_drop() {
        let runtime = runtime();
        send(&runtime.events);
        let mut first = runtime.subscribe_events(limits(3));
        let mut second = runtime.subscribe_events(limits(3));
        assert_eq!(first.start_sequence(), 1);
        assert!(first.try_next_batch(3).is_none());
        send(&runtime.events);
        assert_eq!(sequences(first.try_next_batch(1).unwrap()), vec![2]);
        assert_eq!(sequences(second.try_next_batch(1).unwrap()), vec![2]);
        drop(first);
        assert_eq!(runtime.events.streams.lock().unwrap().readers.len(), 1);
        drop(second);
        assert!(runtime.events.streams.lock().unwrap().readers.is_empty());
    }

    #[test]
    fn concurrent_publishers_deliver_contiguous_batches_in_sequence_order() {
        let runtime = runtime();
        let mut stream = runtime.subscribe_events(limits(512));
        std::thread::scope(|scope| {
            for _ in 0..8 {
                let bus = runtime.events.clone();
                scope.spawn(move || {
                    for _ in 0..64 {
                        send(&bus);
                    }
                });
            }
        });
        let mut delivered = Vec::new();
        while let Some(batch) = stream.try_next_batch(19) {
            delivered.extend(sequences(batch));
        }
        assert_eq!(delivered, (1..=512).collect::<Vec<_>>());
    }

    #[test]
    fn overflow_reports_inclusive_gap_then_continues_without_resubscribing() {
        let runtime = runtime();
        let mut stream = runtime.subscribe_events(limits(2));
        for _ in 0..3 {
            send(&runtime.events);
        }
        assert!(matches!(
            stream.try_next_batch(2),
            Some(EventBatch::Gap {
                first_missed: 1,
                last_missed: 3
            })
        ));
        send(&runtime.events);
        send(&runtime.events);
        assert_eq!(sequences(stream.try_next_batch(2).unwrap()), vec![4, 5]);
    }

    #[test]
    fn events_published_before_and_during_rebootstrap_survive_the_gap_read() {
        let runtime = runtime();
        let mut stream = runtime.subscribe_events(limits(2));
        for _ in 0..4 {
            send(&runtime.events);
        }
        assert!(matches!(
            stream.try_next_batch(2),
            Some(EventBatch::Gap {
                first_missed: 1,
                last_missed: 3
            })
        ));
        send(&runtime.events);
        assert_eq!(sequences(stream.try_next_batch(2).unwrap()), vec![4, 5]);
    }

    #[test]
    fn repeated_overflow_merges_only_dropped_sequences() {
        let runtime = runtime();
        let mut stream = runtime.subscribe_events(limits(1));
        for _ in 0..5 {
            send(&runtime.events);
        }
        assert!(matches!(
            stream.try_next_batch(1),
            Some(EventBatch::Gap {
                first_missed: 1,
                last_missed: 4
            })
        ));
        assert_eq!(sequences(stream.try_next_batch(1).unwrap()), vec![5]);
    }

    #[test]
    fn serialized_byte_limit_is_inclusive_and_overflow_clears_accounting() {
        let runtime = runtime();
        let bytes = serde_json::to_vec(&SequencedRuntimeEvent {
            sequence: 1,
            event: RuntimeEventEnvelope::global(RuntimeEvent::ConfigurationChanged),
        })
        .unwrap()
        .len();
        let mut stream = runtime.subscribe_events(EventQueueLimits {
            max_events: 10,
            max_bytes: bytes,
        });
        send(&runtime.events);
        assert_eq!(stream.queue.lock().unwrap().buffer.bytes, bytes);
        send(&runtime.events);
        let queue = stream.queue.lock().unwrap();
        assert_eq!(queue.buffer.bytes, 0);
        assert!(queue.buffer.events.is_empty());
        drop(queue);
        assert!(matches!(
            stream.try_next_batch(10),
            Some(EventBatch::Gap {
                first_missed: 1,
                last_missed: 2
            })
        ));
        send(&runtime.events);
        assert_eq!(sequences(stream.try_next_batch(1).unwrap()), vec![3]);
        assert_eq!(stream.queue.lock().unwrap().buffer.bytes, 0);
    }

    #[test]
    fn oversized_event_reports_gap_and_does_not_stall_later_events() {
        let runtime = runtime();
        let mut stream = runtime.subscribe_events(EventQueueLimits {
            max_events: 3,
            max_bytes: 100,
        });
        runtime.events.send(RuntimeEventEnvelope::session(
            "s".into(),
            "p".into(),
            RuntimeEvent::AssistantTextDelta {
                generation: 1,
                delta: "x".repeat(101),
            },
        ));
        send(&runtime.events);
        assert!(matches!(
            stream.try_next_batch(3),
            Some(EventBatch::Gap {
                first_missed: 1,
                last_missed: 1
            })
        ));
        assert_eq!(sequences(stream.try_next_batch(3).unwrap()), vec![2]);
    }

    #[test]
    fn zero_limits_report_gaps_and_zero_batch_does_not_consume_them() {
        for limits in [
            limits(0),
            EventQueueLimits {
                max_events: 1,
                max_bytes: 0,
            },
        ] {
            let runtime = runtime();
            let mut stream = runtime.subscribe_events(limits);
            send(&runtime.events);
            assert!(sequences(stream.try_next_batch(0).unwrap()).is_empty());
            assert!(matches!(
                stream.try_next_batch(1),
                Some(EventBatch::Gap {
                    first_missed: 1,
                    last_missed: 1
                })
            ));
            assert!(stream.try_next_batch(1).is_none());
        }
    }

    #[tokio::test]
    async fn cancelled_pending_read_consumes_nothing_even_when_publish_follows_poll() {
        use std::{future::Future, task::Poll};
        let runtime = runtime();
        let mut stream = runtime.subscribe_events(limits(2));
        {
            let pending = stream.next_batch(2);
            tokio::pin!(pending);
            std::future::poll_fn(|cx| {
                assert!(pending.as_mut().poll(cx).is_pending());
                Poll::Ready(())
            })
            .await;
            send(&runtime.events);
        }
        assert_eq!(sequences(stream.next_batch(2).await), vec![1]);
    }

    #[tokio::test]
    async fn pending_read_wakes_on_publish() {
        let runtime = runtime();
        let (waiting, reader) = pending_reader(runtime.subscribe_events(limits(2)));
        waiting.await.unwrap();
        send(&runtime.events);
        assert_eq!(
            sequences(
                tokio::time::timeout(std::time::Duration::from_secs(2), reader)
                    .await
                    .unwrap()
                    .unwrap()
            ),
            vec![1]
        );
    }

    #[tokio::test]
    async fn pending_read_closes_when_last_runtime_drops_even_if_bus_survives() {
        let runtime = runtime();
        let bus = runtime.events.clone();
        let weak = runtime.downgrade();
        let (waiting, reader) = pending_reader(runtime.subscribe_events(limits(2)));
        waiting.await.unwrap();
        drop(runtime);
        assert!(weak.upgrade().is_err());
        send(&bus);
        assert!(matches!(
            tokio::time::timeout(std::time::Duration::from_secs(2), reader)
                .await
                .unwrap()
                .unwrap(),
            EventBatch::Closed
        ));
    }

    #[tokio::test]
    async fn shutdown_wakes_pending_read_and_new_subscriptions_are_closed() {
        let runtime = runtime();
        let (waiting, reader) = pending_reader(runtime.subscribe_events(limits(2)));
        waiting.await.unwrap();
        runtime.shutdown().await;
        assert!(matches!(
            tokio::time::timeout(std::time::Duration::from_secs(2), reader)
                .await
                .unwrap()
                .unwrap(),
            EventBatch::Closed
        ));
        assert!(matches!(
            runtime.subscribe_events(limits(2)).try_next_batch(1),
            Some(EventBatch::Closed)
        ));
    }

    #[test]
    fn close_discards_queued_events_and_pending_gaps() {
        let runtime = runtime();
        let mut stream = runtime.subscribe_events(limits(1));
        for _ in 0..3 {
            send(&runtime.events);
        }
        drop(runtime);
        assert!(matches!(stream.try_next_batch(0), Some(EventBatch::Closed)));
        assert!(matches!(stream.try_next_batch(1), Some(EventBatch::Closed)));
    }

    #[test]
    fn streams_do_not_change_host_channel_envelopes_or_web_delivery() {
        let runtime = runtime();
        let host = Arc::new(RecordingEvents::default());
        runtime.events.subscribe("main", 1, host.clone());
        runtime.events.set_web_events_enabled(true);
        let mut web = runtime.events.subscribe_web();
        let mut stream = runtime.subscribe_events(limits(0));
        let envelope = RuntimeEventEnvelope::session(
            "s".into(),
            "p".into(),
            RuntimeEvent::AssistantTextDelta {
                generation: 1,
                delta: "hello".into(),
            },
        );
        runtime.events.send(envelope.clone());
        assert!(matches!(
            stream.try_next_batch(1),
            Some(EventBatch::Gap { .. })
        ));
        assert_eq!(
            *host.events.lock().unwrap(),
            vec![(
                super::super::RUNTIME_EVENT_NAME.into(),
                serde_json::to_value(&envelope).unwrap()
            )]
        );
        let received = web.try_recv().unwrap();
        assert_eq!(received.sequence, 1);
        assert_eq!(received.event, envelope);
    }
}
