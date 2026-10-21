# Acceptance Record — Desktop WSL/SSH File Links

## Archive decision

- Recorded on 2026-10-21 at the user's request to consolidate acceptance records and archive this task.
- Implementation and updated tests are committed in `d6498c0113405345a67c69cecc032a163c6ac170`, included in tag `v0.3.7`.
- Archived as completed implementation, retaining the browser failures and native verification gaps below. Archiving does not turn incomplete or failed scenarios into passes.
- This record supersedes the old task notes claiming that the browser fixture still expected remote rejection and no tests/builds had run.

## Recovered verification evidence

Source: Trellis session `01a1571e-3cf3-774f-9ca8-bb1d15f30643` (2026-10-20), including original tool results at 02:45–02:51 UTC. The user authorized test updates and verification after implementation. Commit confirmation is in session `01a1574e-04b6-73dc-89ba-8d00e0c02f73`.

| Check | Historical result |
| --- | --- |
| Frontend format/lint check and production build | Passed; saved exit codes zero |
| Node unit / integration suites | 262 / 31 passed, zero failures |
| Rust format / check / clippy | Passed; saved exit codes zero |
| Rust workspace tests | Passed after fixing a moved-value error in a new test; final test exit code zero |
| Rust test groups | 170 + 2 + 44 + 2 + 4 passed, zero failures; other reported groups contained zero tests |
| File-link browser fixture | Passed at actual 1280px/fine-pointer, 320px/touch and 390px/touch viewports |
| Commit hooks | Passed |

The updated browser fixture covers mocked Local/WSL/SSH IPC routing, remote text tabs and errors, legacy HTML opening, the WebUI guard, no automatic opening, search highlights and responsive file-link presentation. `crates/pilo-server/tests/stdio_protocol.rs` adds server-filesystem/binary-transport coverage. These tests are committed, not pending permission to update.

The browser checks use mocked native IPC. They do not prove real remote reads, Windows path handling at runtime, system-default application launch or deployed server compatibility.

## Browser failures that remain unverified

The broader `tests/browser/project-workspace-tabs.html` regression did not finish cleanly in the recovered session:

- One 1280px fine-pointer run passed, followed by a touch run failing `Multiple long titles must shrink and ellipsize before scrolling`; that run's actual width was 1037px, not the intended narrow viewport.
- A later run with verified 1280px viewport failed `Markdown/code preview must have a rounded 1px frame`.
- Final saved browser runner exit codes were both 1. No final passing rerun of the complete shared workspace fixture was found in that session. A later inspection reported browser zoom, but does not establish that either failure was resolved.

Do not report the entire browser suite as passed. These are retained verification gaps, not issues fixed by this documentation-only archive operation.

## Scope disposition and remaining verification

- Remote text/code routing, bounded binary transfer, canonical paths and document safety checks are implemented, with source review and automated checks recorded above.
- Local behavior, the HTML-only legacy entry and WebUI native-opening refusal retain their contracts; mocked regression coverage exists.
- Real Windows desktop Local/WSL/SSH reading, cache snapshot/default-app opening, Unicode/drive paths, remote executable/symlink safety, cache cleanup and deployed server refresh still require dedicated runtime acceptance.
- Rerun the complete shared workspace browser fixture in a controlled viewport/zoom when verification is requested, resolving or explaining the recorded assertions before claiming it passes.
- Remote HTML remains a single-file snapshot: adjacent assets are not synchronized, and no HTTP server is started implicitly.

## Work performed during archiving

Historical tool results, current committed tests and stale task/spec statements were reconciled. No application/test code was changed; no tests, builds, desktop app or browser checks were run during this archive operation. The user requested archiving, not a new Git commit or push.
