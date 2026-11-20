use std::{
    fs::OpenOptions,
    io::{BufWriter, Write},
    time::{Duration, Instant},
};

use super::*;

fn legacy_record_transcript_base(path: String) -> Option<Arc<TranscriptBase>> {
    let mut file = File::open(&path).ok()?;
    let before = file.metadata().ok()?;
    if !before.is_file() {
        return None;
    }
    let size = before.len();
    let mut remaining = size;
    let mut buffer = [0; 64 * 1024];
    let mut digest = Sha256::new();
    let mut last = None;
    while remaining > 0 {
        let limit = remaining.min(buffer.len() as u64) as usize;
        let count = file.read(&mut buffer[..limit]).ok()?;
        if count == 0 {
            return None;
        }
        digest.update(&buffer[..count]);
        remaining -= count as u64;
        last = Some(buffer[count - 1]);
    }
    if size > 0 && last != Some(b'\n') {
        return None;
    }
    let after = file.metadata().ok()?;
    let current = std::fs::metadata(path).ok()?;
    if before.len() != after.len()
        || before.len() != current.len()
        || before.modified().ok()? != after.modified().ok()?
        || before.modified().ok()? != current.modified().ok()?
        || !same_file(&before, &current)
    {
        return None;
    }
    Some(Arc::new(TranscriptBase {
        size,
        tail_digest: digest.finalize().into(),
        metadata: before,
    }))
}

async fn sample(path: String, legacy: bool) -> Duration {
    let start = Instant::now();
    let capture = tokio::task::spawn_blocking(move || {
        if legacy {
            legacy_record_transcript_base(path)
        } else {
            record_transcript_base(path)
        }
    })
    .await
    .unwrap()
    .unwrap();
    let elapsed = start.elapsed();
    std::hint::black_box(capture);
    elapsed
}

fn percentiles(samples: &mut [Duration]) -> Value {
    samples.sort_unstable();
    serde_json::json!({
        "p50Us": samples[(samples.len() * 50).div_ceil(100) - 1].as_secs_f64() * 1_000_000.0,
        "p95Us": samples[(samples.len() * 95).div_ceil(100) - 1].as_secs_f64() * 1_000_000.0,
    })
}

#[tokio::test]
#[ignore = "writes persistent datasets/results to PI_TRANSCRIPT_BENCHMARK_DIR"]
async fn prompt_capture_benchmark() {
    let directory = std::env::var("PI_TRANSCRIPT_BENCHMARK_DIR").expect("set benchmark directory");
    std::fs::create_dir_all(&directory).unwrap();
    let mut results = Vec::new();
    for (label, messages) in [("small", 1_usize), ("large", 10_000)] {
        let path = Path::new(&directory).join(format!("{label}.jsonl"));
        let mut writer = BufWriter::new(File::create(&path).unwrap());
        writeln!(
            writer,
            "{}",
            serde_json::json!({"type":"session","version":3,"id":"benchmark"})
        )
        .unwrap();
        for index in 0..messages {
            let role = if index % 2 == 0 { "user" } else { "assistant" };
            let entry = serde_json::json!({"type":"message","id":format!("m{index}"),"parentId":index.checked_sub(1).map(|id|format!("m{id}")),"message":{"role":role,"content":[{"type":"text","text":"x".repeat(4000)}],"stopReason":"stop"}});
            writeln!(writer, "{entry}").unwrap();
        }
        writer.flush().unwrap();
        drop(writer);
        let bytes = std::fs::metadata(&path).unwrap().len();
        let path = path.to_str().unwrap().to_owned();
        for _ in 0..10 {
            sample(path.clone(), true).await;
            sample(path.clone(), false).await;
        }
        let mut before = Vec::new();
        let mut after = Vec::new();
        for iteration in 0..300 {
            if iteration % 2 == 0 {
                before.push(sample(path.clone(), true).await);
                after.push(sample(path.clone(), false).await);
            } else {
                after.push(sample(path.clone(), false).await);
                before.push(sample(path.clone(), true).await);
            }
        }
        results.push(serde_json::json!({"session":label,"messages":messages,"bytes":bytes,"before":percentiles(&mut before),"after":percentiles(&mut after)}));
    }
    let evidence = serde_json::json!({"baseline":"e8659ef capture implementation reproduced in this harness","profile":"debug, same binary","method":"warm filesystem cache; 10 warm-ups per implementation/file; 300 samples each, alternating old/new order; capture worker including spawn_blocking dispatch/await, excluding file generation and RPC","results":results});
    std::fs::write(
        Path::new(&directory).join("benchmark.json"),
        serde_json::to_vec_pretty(&evidence).unwrap(),
    )
    .unwrap();
    println!("{}", serde_json::to_string_pretty(&evidence).unwrap());
}

async fn time_snapshot(
    path: &str,
    base: Option<Arc<TranscriptBase>>,
    window: TranscriptWindow,
    cache: &tokio::sync::Mutex<SessionHistoryCache>,
) -> Duration {
    let start = Instant::now();
    let result = read_transcript_history(path.to_owned(), base, window, cache, "project")
        .await
        .unwrap();
    std::hint::black_box(result);
    start.elapsed()
}

#[tokio::test]
#[ignore = "writes benchmark results to PI_TRANSCRIPT_BENCHMARK_DIR"]
async fn snapshot_read_benchmark() {
    let directory = std::env::var("PI_TRANSCRIPT_BENCHMARK_DIR").expect("set benchmark directory");
    std::fs::create_dir_all(&directory).unwrap();
    let path = Path::new(&directory).join("turn.jsonl");
    let mut writer = BufWriter::new(File::create(&path).unwrap());
    writeln!(
        writer,
        "{}",
        serde_json::json!({"type":"session","version":3,"id":"benchmark"})
    )
    .unwrap();
    for index in 0..9_000_usize {
        let role = if index % 2 == 0 { "user" } else { "assistant" };
        let entry = serde_json::json!({"type":"message","id":format!("m{index}"),"parentId":index.checked_sub(1).map(|id|format!("m{id}")),"message":{"role":role,"content":[{"type":"text","text":"x".repeat(4000)}],"stopReason":"stop"}});
        writeln!(writer, "{entry}").unwrap();
    }
    writer.flush().unwrap();
    drop(writer);
    let path = path.to_str().unwrap().to_owned();
    let prefix_bytes = std::fs::metadata(&path).unwrap().len();
    let base = record_transcript_base(path.clone()).unwrap();
    // The turn appends 1,000 more messages after the boundary.
    let mut writer = BufWriter::new(OpenOptions::new().append(true).open(&path).unwrap());
    for index in 9_000_usize..10_000 {
        let role = if index % 2 == 0 { "user" } else { "assistant" };
        let entry = serde_json::json!({"type":"message","id":format!("m{index}"),"parentId":index.checked_sub(1).map(|id|format!("m{id}")),"message":{"role":role,"content":[{"type":"text","text":"x".repeat(4000)}],"stopReason":"stop"}});
        writeln!(writer, "{entry}").unwrap();
    }
    writer.flush().unwrap();
    drop(writer);
    let grown_bytes = std::fs::metadata(&path).unwrap().len();

    let mut results = Vec::new();

    // Before: every snapshot is a full prefix parse (the previous code path,
    // read_local_projection, is unchanged).
    let mut before = Vec::new();
    for _ in 0..5 {
        let probe_path = path.clone();
        let probe_base = base.clone();
        let start = Instant::now();
        let parsed = tokio::task::spawn_blocking(move || {
            read_local_projection(Path::new(&probe_path), Some(probe_base.as_ref()))
        })
        .await
        .unwrap()
        .unwrap();
        std::hint::black_box(parsed);
        before.push(start.elapsed());
    }

    // After: the snapshot of the prompt boundary hits the projection its own
    // first call stored.
    let cache = tokio::sync::Mutex::new(SessionHistoryCache::default());
    let cold = time_snapshot(
        &path,
        Some(base.clone()),
        TranscriptWindow::default(),
        &cache,
    )
    .await;
    let mut after = Vec::new();
    for _ in 0..5 {
        after.push(
            time_snapshot(
                &path,
                Some(base.clone()),
                TranscriptWindow::default(),
                &cache,
            )
            .await,
        );
    }

    // An older page during the turn: a windowed read of the boundary with the
    // projection warm serves the slice without parsing; the cold column is
    // the same first read under a fresh cache.
    let window = TranscriptWindow {
        start_message: Some(8_990),
        message_limit: Some(10),
        include_message_index: false,
    };
    let cold_page = time_snapshot(
        &path,
        Some(base.clone()),
        window,
        &tokio::sync::Mutex::new(SessionHistoryCache::default()),
    )
    .await;
    let mut warm_page = Vec::new();
    for _ in 0..5 {
        warm_page.push(time_snapshot(&path, Some(base.clone()), window, &cache).await);
    }

    // Live-file reads after the boundary was stored extend the projection
    // instead of re-parsing the whole transcript.
    let mut extension = Vec::new();
    for _ in 0..5 {
        extension.push(time_snapshot(&path, None, TranscriptWindow::default(), &cache).await);
    }

    results.push(serde_json::json!({
        "prefixBytes": prefix_bytes,
        "grownBytes": grown_bytes,
        "prefixMessages": 9_000,
        "grownMessages": 10_000,
        "coldSnapshotUs": cold.as_secs_f64() * 1_000_000.0,
        "before": percentiles(&mut before),
        "after": percentiles(&mut after),
        "coldPageUs": cold_page.as_secs_f64() * 1_000_000.0,
        "warmPage": percentiles(&mut warm_page),
        "extension": percentiles(&mut extension),
    }));
    let evidence = serde_json::json!({"benchmark":"snapshot read through the session history cache","profile":"debug","method":"warm filesystem cache; 5 timed samples per scenario","results":results});
    std::fs::write(
        Path::new(&directory).join("snapshot_benchmark.json"),
        serde_json::to_vec_pretty(&evidence).unwrap(),
    )
    .unwrap();
    println!("{}", serde_json::to_string_pretty(&evidence).unwrap());
}
