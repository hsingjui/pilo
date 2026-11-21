use std::io::{BufRead, Read, Seek, SeekFrom};

use serde_json::Value;

pub(crate) const SESSION_INDEX_TAIL_BYTES: usize = 32 * 1024;
const SESSION_INDEX_PREVIEW_CHARS: usize = 160;
pub(super) const SESSION_INDEX_MAX_PARSE_BYTES: usize = 64 * 1024;

/// 渐进式前缀扫描 + 尾窗合并，缺失标题时流式补扫。
///
/// 真实数据里 65% 的会话在首个 16KB 阶段就能凑齐标题和预览，因此每阶段
/// 只解析新增字节、凑齐后立即停止，避免为常见情况付出 256KB 的解析成本。
///
/// 尾窗承载文件末尾的改名，只要文件存在尾窗区域就始终读取：前缀即使已
/// 凑齐 `name`/`first_user_message_preview`，也不能跳过尾窗，否则末尾的
/// 改名会被更早的标题覆盖。
///
/// 前缀读取失败返回 `Ok(None)`（跳过该文件）；尾窗/补扫 I/O 失败返回 `Err`。
pub(crate) fn scan_index<R: Read + Seek>(
    reader: &mut R,
    size: u64,
) -> Result<Option<SessionIndexSummary>, String> {
    let Some(mut summary) = scan_index_windows(reader, size)? else {
        return Ok(None);
    };
    if summary
        .name
        .as_deref()
        .is_none_or(|name| name.trim().is_empty())
    {
        scan_session_name(reader, size, 0, &mut summary)?;
    }
    Ok(Some(summary))
}

pub(super) fn scan_index_windows<R: Read + Seek>(
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

pub(super) fn scan_session_name<R: Read + Seek>(
    reader: &mut R,
    size: u64,
    start: u64,
    summary: &mut SessionIndexSummary,
) -> Result<(), String> {
    reader
        .seek(SeekFrom::Start(start))
        .map_err(|error| format!("failed to seek session index name: {error}"))?;
    let mut reader = std::io::BufReader::new(reader.take(size - start));
    if start > 0 {
        reader
            .skip_until(b'\n')
            .map_err(|error| format!("failed to skip session index boundary: {error}"))?;
    }
    let mut line = Vec::new();
    loop {
        line.clear();
        let read = reader
            .by_ref()
            .take((SESSION_INDEX_MAX_PARSE_BYTES + 1) as u64)
            .read_until(b'\n', &mut line)
            .map_err(|error| format!("failed to read session index name: {error}"))?;
        if read == 0 {
            break;
        }
        if !line.ends_with(b"\n") {
            reader
                .skip_until(b'\n')
                .map_err(|error| format!("failed to skip session index line: {error}"))?;
            continue;
        }
        if memchr::memmem::find(&line, b"session_info").is_some()
            && let Some(value) = parse_index_line(&line[..line.len() - 1])
            && value.get("type").and_then(Value::as_str) == Some("session_info")
        {
            summary.update(&value);
        }
    }
    summary.name_scanned = true;
    Ok(())
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
    if line.len() > SESSION_INDEX_MAX_PARSE_BYTES {
        return None;
    }
    let line = line.strip_prefix(b"\xef\xbb\xbf").unwrap_or(line);
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
    pub(super) name_scanned: bool,
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
