# Session History Cache

## 1. Scope / Trigger

Apply to history reads, window serialization and lazy image lookup in
`runtime/session_history/`. Desktop and WebUI use the same Host cache for
Local/WSL/SSH; Pi JSONL in its original environment remains authoritative. This
also covers assistant completion times shared by live and saved transcripts.

## 2. Signatures

- `read_history_json(..., expected_fingerprint) -> Result<Vec<u8>, String>`
- `read_history_window_json(..., expected_fingerprint, start_message,
  message_limit, include_message_index) -> Result<Vec<u8>, String>`
- `read_history_image_bytes(..., image_id, expected_fingerprint)` reads source
  ranges using the image-location index, not cached base64 payloads.
- Completed turn record: Pi JSONL `custom` entry with
  `customType: "pilo.turn-completed.v1"` and `data: { completedAtMs }` (Unix ms).
- Fingerprint: `{ fileSize, fileMtimeNs }`. History windows retain the existing
  `windowStartMessage`, `windowMessageCount`, `totalMessages`, optional
  `messageIndex`, and fingerprint fields. Limits clamp to 1–256 messages.

## 3. Contracts

- StreamGuard appends the completion entry at `agent_settled` for runs with
  an assistant message. Pi emits `entry_appended` before the RPC `agent_settled`;
  the Host publishes the recorded time as `assistant_message_end.timestampMs`.
  History uses the same entry to close the current assistant turn or update
  its timestamp when Pi compacted after the reply. The record does not
  contribute a row or model content. Keep StreamGuard ahead of the
  built-ins that snapshot the session leaf at settlement.
- Cache keys include project ID and source path. Merge overlapping
  loads with a per-key lock, then recheck fingerprinted caches inside the lock.
  A client fingerprint can hit the cache directly. If it misses an existing
  projection, probe the source fingerprint and try the cache again before
  rebuilding. A failed probe or missing source fingerprint must not evict.
  Release the per-key lock before reading individual image payloads or history pages.
- Cold loads share two global semaphore slots across projects/connections and
  both full-history and image-index scans. Cache hits bypass these slots. Acquire
  the per-key lock before the global slot; parsing, projection, serialization
  and disk writes retain shared ownership of the permit, including blocking
  tasks whose HTTP callers are cancelled. Keep the old memory or disk projection
  until a new one is cached or normal eviction applies; only its original
  fingerprint can hit it.
- Index user-image JSONL ranges before dropping their base64 `data` from parsed
  entries. Keep image IDs, content positions and MIME types for projection;
  lazy reads still decode the original source range. Tool-result image payloads
  are unchanged.
- Memory LRU: 16 entries, 64 MiB estimated using source size × 2. Histories
  exceeding this estimate use disposable projected-history files when eligible.
- Disk LRU: 16 entries, 2 GiB total projected bytes and 64 MiB estimated indexes.
  Indexes include message ranges, the serialized directory and its entry ranges,
  image locations and the incremental checkpoint.
  Eviction releases cache ownership; in-flight readers may retain handles.
- Disk files are caches, never source copies or SQLite conversation storage.
  Use random create-new names in the OS temporary directory. Unix uses mode 0600
  and immediate unlink; Windows uses delete-on-close. Closing the last handle
  releases the file. No cache paths or conversation payloads enter logs.
- A warm disk page reads only its contiguous message range and response metadata.
  Cold reads scan/project the entire source to resolve branches, stats and
  lazy-image indexes. Parsing and serialization run in blocking tasks.
- Incremental loads: when the fingerprint misses, the source has grown, and a
  cached projection has a checkpoint, reread from the checkpoint line and splice
  the reprojected tail after the cached messages before it. Both the metadata
  probe and the actual `session.read` snapshot must show growth over the cached
  file size. This runs under the same per-key lock and global slot as a cold load.
  For an append, the result must match a full parse byte for byte: serialized
  history, message ranges, directory JSON and ranges, image locations, stats
  (including `contextTokens`), model, thinking level, name, `headerMissing` and
  `sourceMessageCount`.
- Checkpoint: the last user message or `compaction` on the active branch whose
  line is newline-terminated and has a non-empty id. Both close the previous turn
  and start their own projected message, so messages before them never change
  while the checkpoint stays on the branch, except when a settlement record
  updates a reply before a compaction checkpoint. It records the branch state before
  it, running stats over all earlier source entries (kept in source order so the
  float cost sum matches), and the branch context tokens before it.
- Verification: the parser hashes newline-terminated lines with SHA-256 from offset
  0. The checkpoint keeps the hash state at its line; the projection keeps the
  digest at the committed offset (after the last newline). A resume continues
  that state over the reread bytes and must reproduce the digest exactly at the
  committed offset. A torn last line is projected like a full read but never
  becomes a checkpoint and is reread next time.
- The resumed branch, walked from the last entry with an id, must reach the
  checkpoint entry. This relies on Pi entry ids being unique within a file.
- Fallback to a full cold read: no checkpoint, no source growth (including a
  same-size mtime change or truncation of an uncommitted last line), 64 consecutive
  incremental updates (the counter resets on a full read), a digest mismatch,
  a branch that leaves the checkpoint, a parent cycle, or any read/projection error.
  A growing source is assumed to append without editing bytes before the
  checkpoint; the update limit bounds drift if that assumption is violated.
- Neither the incremental attempt nor its full fallback evicts the previous
  projection before a replacement is cached. Disk projections are extended into
  a new disposable file by copying the cached prefix locally.
- Oversized indexes/projections or a cache file creation/write failure fall back
  to returning the uncached projection. This preserves behavior, not cold-read
  peak-memory bounds. Cache accounting is not an exact process-RSS limit.

## 4. Validation & Error Matrix

| Condition | Behavior |
| --- | --- |
| No completion entry | Live uses the Host receipt time; history retains the last related Pi entry time |
| Completion belongs to a reply before the cached compaction | Full cold read, so the reply timestamp in the prefix is also updated |
| Matching fingerprint | Reuse memory or disk projection without cold-load admission |
| Two other cold scans are running | Wait for a global slot; do not allocate another parser |
| Cold-load HTTP caller cancels during blocking work | Keep its slot until that blocking work ends |
| User image line is indexed | Release parsed base64 data; lazy source reads remain valid |
| Stale client fingerprint but the source matches the cache | Reuse the current projection and return its fingerprint |
| Source fingerprint differs from the cached fingerprint | Keep the cached projection until a replacement is cached or normal eviction applies |
| Cold rebuild fails, is cancelled, or returns uncached history | Keep the existing projection available for its original fingerprint |
| Over disk/index budget | Return uncached history |
| Temporary cache creation/write fails | Log warning without payload; return history |
| Cached range read fails | Return error; do not return partial JSON |
| Source changes during scan | Keep existing bounded retry/snapshot behavior |
| Source grew, checkpoint still on the branch | Reread from the checkpoint; splice the verified tail |
| Changed fingerprint without growth, or bytes in the verified range changed | Full cold read |
| Branch leaves the checkpoint, parent cycle, or 64 incremental updates | Full cold read |
| Incremental read fails or the caller cancels | Keep the cached projection; fall back or return the error |

## 5. Good / Base / Bad Cases

- Good: the completed reply has the same timestamp live and after reopening.
- Good: repeatedly page a large history without rescanning the remote JSONL.
- Good: after a turn, read only the bytes from the last user message onward.
- Base: small histories stay in memory with the existing window contract.
- Bad: treating the disposable projection as authoritative or claiming cold
  reads have bounded memory because warm pages do.
- Bad: resuming from a line that may still grow, or from an entry whose earlier
  projected messages depend on later entries (anything but a user message or a
  compaction).

## 6. Tests Required

Existing WSL history tests have passed. These additional assertion points await
targeted regression coverage; no new repository tests have been added:

- A settled reply keeps the same time through live delivery, reconnect replay
  and history reload, including after tools or an automatic retry.
- Concurrent distinct-key cold loads stay within two slots; cached pages do not
  wait behind them. Cancellation keeps a slot while blocking parse/serialize/write
  continues. User-image data is not retained in parser entries and lazy image
  bytes still match the original JSONL, including split lines and multiple images.
- Memory/disk pages produce identical events, directory, stats and fingerprints,
  including empty windows and start/limit clamping.
- Concurrent first loads share a cached projection; a changed source fingerprint
  rebuilds, but a stale client fingerprint alone does not. A failed or cancelled
  rebuild does not remove an old memory or disk projection that can still serve
  its fingerprint. A same-size mtime change or truncation confined to a torn
  last line triggers a full read even if the checkpoint digest would match.
- Byte/index/count eviction releases handles without breaking in-flight reads.
- Windows close/crash and Unix unlink remove disposable files; write failure
  preserves the uncached response. Check Local/WSL/SSH and lazy image lookup.
- `session_history/tests.rs` covers incremental loads against full parses: plain
  and chained appends, a torn or unterminated last line, a branch switch after the
  checkpoint, compaction, images, model/thinking/session-info changes, unchanged
  bytes, disk-to-disk extension; and fallbacks for truncation, same-size rewrites,
  leaving the checkpoint, parent cycles and the update limit. A cache that cannot
  take a replacement keeps its old projection. Run natively on Windows with
  `cargo test -p pilo --lib session_history`.

## 7. Wrong vs Correct

- Wrong: use a browser receipt time or the prompt timestamp as the finished
  reply time. Correct: use the completion timestamp persisted by Pi.
- Wrong: bypass the cache whenever a source exceeds the memory LRU budget, so
  every page rescans and replays the entire file.
- Correct: keep an eligible disposable projection plus message-range index,
  then read only the requested window; retain the source fingerprint contract.
