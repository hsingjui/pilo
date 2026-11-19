use std::{
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
