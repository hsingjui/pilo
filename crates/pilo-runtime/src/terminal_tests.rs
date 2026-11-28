use super::*;

#[tokio::test]
async fn terminal_stream_preserves_bytes_order_and_closes_cleanly() {
    let bus = TerminalEventBus::default();
    let stream = bus.subscribe(TERMINAL_QUEUE_MAX_BYTES);
    let expected = vec![
        TerminalEvent::Output {
            terminal_id: "t".into(),
            data: vec![0, 255, 10],
            start_offset: 0,
        },
        TerminalEvent::Output {
            terminal_id: "t".into(),
            data: vec![],
            start_offset: 3,
        },
        TerminalEvent::Exit {
            terminal_id: "t".into(),
        },
        TerminalEvent::Error {
            terminal_id: "t".into(),
            message: "closed".into(),
        },
    ];
    for event in &expected {
        bus.publish(event.clone());
    }
    assert_eq!(stream.next_batch(2).await, expected[..2]);
    bus.close();
    assert_eq!(stream.next_batch(10).await, expected[2..]);
    assert!(stream.next_batch(10).await.is_empty());
}

#[tokio::test]
async fn terminal_stream_evicts_oldest_events_above_byte_limit() {
    let bus = TerminalEventBus::default();
    let stream = bus.subscribe(160);
    bus.publish(TerminalEvent::Output {
        terminal_id: "t".into(),
        data: vec![1; 100],
        start_offset: 0,
    });
    bus.publish(TerminalEvent::Output {
        terminal_id: "t".into(),
        data: vec![2; 100],
        start_offset: 100,
    });
    assert_eq!(
        stream.next_batch(10).await,
        vec![TerminalEvent::Output {
            terminal_id: "t".into(),
            data: vec![2; 100],
            start_offset: 100,
        }]
    );
}

#[tokio::test]
async fn terminal_stream_close_wakes_pending_waiter() {
    let bus = TerminalEventBus::default();
    let stream = bus.subscribe(TERMINAL_QUEUE_MAX_BYTES);
    let waiter = tokio::spawn(async move { stream.next_batch(16).await });
    tokio::task::yield_now().await;
    bus.close();
    assert!(waiter.await.unwrap().is_empty());
}

#[test]
fn output_ring_buffer_keeps_latest_64_kib() {
    let mut buffer = OutputRingBuffer::default();
    buffer.push(&vec![b'a'; TERMINAL_SNAPSHOT_MAX_BYTES - 4]);
    buffer.push(b"12345678");
    let snapshot = buffer.snapshot();
    assert_eq!(snapshot.len(), TERMINAL_SNAPSHOT_MAX_BYTES);
    assert!(snapshot.ends_with(b"12345678"));
    assert_eq!(snapshot[0], b'a');

    let mut oversize = vec![b'x'; TERMINAL_SNAPSHOT_MAX_BYTES + 128];
    oversize.extend_from_slice(b"tail");
    buffer.push(&oversize);
    let snapshot = buffer.snapshot();
    assert_eq!(snapshot.len(), TERMINAL_SNAPSHOT_MAX_BYTES);
    assert!(snapshot.ends_with(b"tail"));
}
