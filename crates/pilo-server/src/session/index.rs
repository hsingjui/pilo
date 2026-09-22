use std::{
    collections::HashMap,
    io::{BufRead, Read, Seek, SeekFrom},
    path::PathBuf,
    sync::{
        Mutex as StdMutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::UNIX_EPOCH,
};

use pilo_protocol::SessionFile;
use serde::Deserialize;
use serde_json::Value;

use super::{agent_dir, session_dir_key};
use crate::to_value;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SessionScanParams {
    project: String,
    #[serde(default)]
    known: Vec<SessionScanKnownFile>,
    #[serde(default)]
    summary_limit: Option<usize>,
    #[serde(default)]
    paths: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionScanKnownFile {
    path: String,
    size: u64,
    mtime_ns: u64,
}

pub(crate) const SESSION_INDEX_HEADER_BYTES: usize = 16 * 1024;
pub(crate) const SESSION_INDEX_TAIL_BYTES: usize = 32 * 1024;
const SESSION_INDEX_PREVIEW_CHARS: usize = 160;

pub(crate) fn session_scan(params: SessionScanParams) -> Result<Value, String> {
    let known = params
        .known
        .into_iter()
        .map(|file| (file.path, (file.size, file.mtime_ns)))
        .collect::<HashMap<_, _>>();
    let Some(root) =
        agent_dir().map(|root| root.join("sessions").join(session_dir_key(&params.project)))
    else {
        return to_value(Vec::<SessionFile>::new());
    };

    let explicit_paths = !params.paths.is_empty();
    let mut paths = if !explicit_paths {
        let Ok(entries) = std::fs::read_dir(&root) else {
            return to_value(Vec::<SessionFile>::new());
        };
        entries
            .flatten()
            .map(|entry| entry.path())
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
            .collect::<Vec<_>>()
    } else {
        params
            .paths
            .into_iter()
            .map(PathBuf::from)
            .filter(|path| path.parent() == Some(root.as_path()))
            .filter(|path| path.extension().and_then(|value| value.to_str()) == Some("jsonl"))
            .collect::<Vec<_>>()
    };

    if !explicit_paths
        && known.is_empty()
        && let Some(summary_limit) = params.summary_limit
    {
        paths.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
        let deferred_paths = if paths.len() > summary_limit {
            paths.split_off(summary_limit)
        } else {
            Vec::new()
        };
        let mut files = summarize_session_files(session_file_stats(paths))?;
        files.extend(deferred_paths.into_iter().map(|path| SessionFile {
            path: path.to_string_lossy().into_owned(),
            size: 0,
            mtime_ns: 0,
            header: Value::Null,
            unchanged: false,
            deferred: true,
            name: None,
            first_user_message_preview: None,
        }));
        return to_value(files);
    }

    let mut candidates = session_file_stats(paths);

    candidates.sort_by(|left, right| {
        right
            .mtime_ns
            .cmp(&left.mtime_ns)
            .then_with(|| right.path_text.cmp(&left.path_text))
    });

    let summary_limit = params.summary_limit.unwrap_or(usize::MAX);
    let mut summaries_started = 0_usize;
    let mut files = vec![None; candidates.len()];
    let mut summarize_indices = Vec::new();
    for (index, candidate) in candidates.iter().enumerate() {
        let unchanged = known
            .get(&candidate.path_text)
            .is_some_and(|fingerprint| *fingerprint == (candidate.size, candidate.mtime_ns));
        if unchanged {
            files[index] = Some(SessionFile {
                path: candidate.path_text.clone(),
                size: candidate.size,
                mtime_ns: candidate.mtime_ns,
                header: Value::Null,
                unchanged: true,
                deferred: false,
                name: None,
                first_user_message_preview: None,
            });
            continue;
        }

        if summaries_started >= summary_limit {
            files[index] = Some(SessionFile {
                path: candidate.path_text.clone(),
                size: candidate.size,
                mtime_ns: candidate.mtime_ns,
                header: Value::Null,
                unchanged: false,
                deferred: true,
                name: None,
                first_user_message_preview: None,
            });
            continue;
        }
        summaries_started += 1;
        summarize_indices.push(index);
    }

    if !summarize_indices.is_empty() {
        let worker_count = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(4)
            .min(8)
            .min(summarize_indices.len());
        let next = AtomicUsize::new(0);
        let results = StdMutex::new(Vec::with_capacity(summarize_indices.len()));
        std::thread::scope(|scope| {
            for _ in 0..worker_count {
                scope.spawn(|| {
                    loop {
                        let work_index = next.fetch_add(1, Ordering::Relaxed);
                        let Some(candidate_index) = summarize_indices.get(work_index).copied()
                        else {
                            break;
                        };
                        let result = summarize_session_file(&candidates[candidate_index]);
                        results
                            .lock()
                            .expect("session summary results poisoned")
                            .push((candidate_index, result));
                    }
                });
            }
        });
        for (index, result) in results
            .into_inner()
            .expect("session summary results poisoned")
        {
            files[index] = result?;
        }
    }

    to_value(files.into_iter().flatten().collect::<Vec<_>>())
}

struct SessionFileStat {
    path: PathBuf,
    path_text: String,
    size: u64,
    mtime_ns: u64,
}

fn session_file_stats(paths: Vec<PathBuf>) -> Vec<SessionFileStat> {
    if paths.is_empty() {
        return Vec::new();
    }
    let worker_count = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(4)
        .min(8)
        .min(paths.len());
    let next = AtomicUsize::new(0);
    let results = StdMutex::new(Vec::with_capacity(paths.len()));
    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(path) = paths.get(index) else {
                        break;
                    };
                    if let Some(stat) = session_file_stat(path.clone()) {
                        results
                            .lock()
                            .expect("session stat results poisoned")
                            .push(stat);
                    }
                }
            });
        }
    });
    results.into_inner().expect("session stat results poisoned")
}

fn summarize_session_files(candidates: Vec<SessionFileStat>) -> Result<Vec<SessionFile>, String> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let worker_count = std::thread::available_parallelism()
        .map(usize::from)
        .unwrap_or(4)
        .min(8)
        .min(candidates.len());
    let next = AtomicUsize::new(0);
    let results = StdMutex::new(Vec::with_capacity(candidates.len()));
    std::thread::scope(|scope| {
        for _ in 0..worker_count {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::Relaxed);
                    let Some(candidate) = candidates.get(index) else {
                        break;
                    };
                    let result = summarize_session_file(candidate);
                    results
                        .lock()
                        .expect("session summary results poisoned")
                        .push((index, result));
                }
            });
        }
    });
    let mut results = results
        .into_inner()
        .expect("session summary results poisoned");
    results.sort_by_key(|(index, _)| *index);
    let mut files = Vec::with_capacity(results.len());
    for (_, result) in results {
        if let Some(file) = result? {
            files.push(file);
        }
    }
    Ok(files)
}

fn session_file_stat(path: PathBuf) -> Option<SessionFileStat> {
    let metadata = std::fs::metadata(&path).ok()?;
    let size = metadata.len();
    let mtime_ns = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(UNIX_EPOCH).ok())
        .map(|value| value.as_nanos() as u64)
        .unwrap_or(0);
    Some(SessionFileStat {
        path_text: path.to_string_lossy().into_owned(),
        path,
        size,
        mtime_ns,
    })
}

fn summarize_session_file(candidate: &SessionFileStat) -> Result<Option<SessionFile>, String> {
    let file = match std::fs::File::open(&candidate.path) {
        Ok(value) => value,
        Err(_) => return Ok(None),
    };
    let mut reader = std::io::BufReader::new(file);
    let mut line = String::new();
    {
        let mut limited_header = reader.by_ref().take(SESSION_INDEX_HEADER_BYTES as u64);
        if limited_header.read_line(&mut line).is_err() {
            return Ok(None);
        }
    }
    if !line.ends_with('\n') && candidate.size > line.len() as u64 {
        return Ok(None);
    }
    let Ok(header) = serde_json::from_str(line.trim()) else {
        return Ok(None);
    };

    let Some(summary) = scan_index(&mut reader, candidate.size)? else {
        return Ok(None);
    };
    Ok(Some(SessionFile {
        path: candidate.path_text.clone(),
        size: candidate.size,
        mtime_ns: candidate.mtime_ns,
        header,
        unchanged: false,
        deferred: false,
        name: summary.name,
        first_user_message_preview: summary.first_user_message_preview,
    }))
}

/// 渐进式前缀扫描 + 尾窗合并。
///
/// 真实数据里 65% 的会话在首个 16KB 阶段就能凑齐标题和预览，因此每阶段
/// 只解析新增字节、凑齐后立即停止，避免为常见情况付出 256KB 的解析成本。
///
/// 尾窗承载文件末尾的改名，只要文件存在尾窗区域就始终读取：前缀即使已
/// 凑齐 `name`/`first_user_message_preview`，也不能跳过尾窗，否则末尾的
/// 改名会被更早的标题覆盖。
///
/// 前缀读取失败返回 `Ok(None)`（跳过该文件）；seek/read 尾窗失败返回 `Err`。
pub(crate) fn scan_index<R: Read + Seek>(
    reader: &mut R,
    size: u64,
) -> Result<Option<SessionIndexSummary>, String> {
    let mut summary = SessionIndexSummary::default();
    let mut read_so_far = 0_usize;
    for stage_bytes in SESSION_INDEX_PREFIX_STAGES {
        // 每阶段只读取上一阶段边界到本阶段边界之间的新增字节。
        let stage_len = stage_bytes - read_so_far;
        let mut stage = vec![0_u8; stage_len];
        let mut filled = 0_usize;
        let mut reached_eof = false;
        while filled < stage_len {
            match reader.read(&mut stage[filled..]) {
                Ok(0) => {
                    reached_eof = true;
                    break;
                }
                Ok(read_count) => filled += read_count,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => return Ok(None),
            }
        }
        stage.truncate(filled);
        read_so_far += filled;
        summarize_prefix_into(&stage, &mut summary);
        if reached_eof || summary.is_complete() {
            break;
        }
    }

    if size > SESSION_INDEX_TAIL_BYTES as u64 {
        let mut tail = Vec::new();
        reader
            .seek(SeekFrom::Start(size - SESSION_INDEX_TAIL_BYTES as u64))
            .map_err(|error| format!("failed to seek session index tail: {error}"))?;
        reader
            .take(SESSION_INDEX_TAIL_BYTES as u64)
            .read_to_end(&mut tail)
            .map_err(|error| format!("failed to read session index tail: {error}"))?;
        // 尾窗代表最近的改名；预览兜底不会生效（预览只能来自前缀）。
        summarize_index_bytes(&tail, true, &mut summary);
    }
    Ok(Some(summary))
}

/// 渐进式前缀窗口的字节边界。真实数据分布：52/130 停在 16KB，
/// 42/130 停在 64KB，8/130 需要 256KB，28/130 走到尾窗。
#[cfg_attr(test, allow(dead_code))]
pub(crate) const SESSION_INDEX_PREFIX_STAGES: [usize; 3] = [16 * 1024, 64 * 1024, 256 * 1024];

/// 把一段完整 JSONL 行字节流并入 summary。`drop_first_partial` 用于
/// 尾窗：第一个 \n 前的字节是上一行被窗口切断的残留，必须跳过。
pub(crate) fn summarize_index_bytes(
    bytes: &[u8],
    drop_first_partial: bool,
    summary: &mut SessionIndexSummary,
) {
    for value in complete_json_lines(bytes, drop_first_partial) {
        summary.update(&value);
    }
}

/// 渐进式扫描中处理一段新增的前缀字节。新增段可能从某行中间开始
/// （上一阶段恰好在行边界之后截断的行），这里沿用"只解析完整行"
/// 的规则：段首的残行不解析，段尾的不完整行留待下一阶段。
fn summarize_prefix_into(bytes: &[u8], summary: &mut SessionIndexSummary) {
    summarize_index_bytes(bytes, false, summary);
}

/// 扫描窗口内 JSONL 行的字节级预筛：
/// 绝大多数行不含任何关心的事件标记，直接跳过 JSON 解析。
/// 256KB 窗口内 `serde_json::from_slice` 只会对 `session_info` /
/// `message` 行发生（后者约占会话文件的一半，但预览凑齐后即停）。
fn contains_index_marker(line: &[u8]) -> bool {
    memchr::memmem::find(line, b"session_info").is_some()
        || memchr::memmem::find(line, b"\"message\"").is_some()
}

/// 解析扫描窗口内的完整 JSONL 行，只解析含关心事件的行。
/// 超大行（system 上下文 / 整段日志 / base64 图片，动辄数百 KB）直接丢弃：
/// 截断成非法 JSON 也无法解析，与其为它构建完整 JSON DOM，不如不解析。
/// 代价是丢掉这条超大消息的预览/改名；超大行极少是首条 user 消息，实测影响
/// 可忽略，若将来确有超大首条消息需要预览，再改为流式解析行头。
fn parse_index_line(line: &[u8]) -> Option<Value> {
    const MAX_PARSE_BYTES: usize = 64 * 1024;
    if line.len() > MAX_PARSE_BYTES {
        return None;
    }
    serde_json::from_slice::<Value>(line).ok()
}

fn complete_json_lines(bytes: &[u8], drop_first_partial: bool) -> impl Iterator<Item = Value> + '_ {
    let start = if drop_first_partial {
        bytes
            .iter()
            .position(|byte| *byte == b'\n')
            .map(|index| index + 1)
            .unwrap_or(bytes.len())
    } else {
        0
    };
    let end = bytes[start..]
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map(|index| start + index + 1)
        .unwrap_or(start);
    bytes[start..end]
        .split(|byte| *byte == b'\n')
        .filter(|line| !line.is_empty())
        .filter(|line| contains_index_marker(line))
        .filter_map(parse_index_line)
}

#[derive(Default)]
pub(crate) struct SessionIndexSummary {
    pub(crate) name: Option<String>,
    pub(crate) first_user_message_preview: Option<String>,
}

impl SessionIndexSummary {
    fn is_complete(&self) -> bool {
        self.name.is_some() && self.first_user_message_preview.is_some()
    }

    fn update(&mut self, value: &Value) {
        match value.get("type").and_then(Value::as_str) {
            Some("session_info") => {
                if let Some(next) = value.get("name").and_then(Value::as_str) {
                    self.name = Some(next.to_owned());
                }
            }
            Some("message") if self.first_user_message_preview.is_none() => {
                if value.pointer("/message/role").and_then(Value::as_str) != Some("user") {
                    return;
                }
                // 第一条 user 消息可能是纯图片或空内容，提取不到文本时保持
                // None 继续向后找，避免预览永远停在空值。
                if let Some(preview) = extract_session_preview(value.pointer("/message/content")) {
                    self.first_user_message_preview = Some(preview);
                }
            }
            _ => {}
        }
    }
}

fn extract_session_preview(content: Option<&Value>) -> Option<String> {
    let text = match content? {
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(" "),
        _ => return None,
    };
    let compact = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!compact.is_empty()).then(|| compact.chars().take(SESSION_INDEX_PREVIEW_CHARS).collect())
}
