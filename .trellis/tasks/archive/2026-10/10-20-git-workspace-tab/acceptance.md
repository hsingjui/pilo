# Acceptance Record — Desktop Git Workspace Tab

## Archive decision

- Recorded on 2026-10-21 at the user's request to consolidate acceptance records and archive this task.
- Implementation is committed in `f7ceb680d0333aea244ab783578a9fb59cd8676e`; follow-up syntax bundle reduction is committed in `1783432`. Both are included in tag `v0.3.7`.
- Archived as completed implementation, with the runtime verification gaps below explicitly retained. This is not a claim that every acceptance scenario passed.
- This record supersedes the earlier statements that tests still used `activePath`, compilation/builds were unexecuted, and the feature was uncommitted. The dated implementation notes remain historical evidence.

## Recovered verification evidence

Source: Trellis session `01a158f9-a6a5-7014-bcb1-eae8c5083d7c` (2026-10-20, review/fix/verification/commit conversation), including original tool results at 12:40–12:42 UTC. The user separately authorized test updates and verification in that session.

| Check | Historical result |
| --- | --- |
| `pnpm check` | Passed: formatting and lint |
| TypeScript no-emit check | Passed, as recorded in the session |
| Frontend production build | Passed; chunk-size warnings were present at that point |
| Node unit / integration suites | 280 / 31 passed, zero failures |
| Focused `project-workspace.test.ts` run | 8 passed, zero failures |
| Rust workspace formatting / check / clippy | Passed; recorded exit codes were all zero |
| `git diff --check` and commit hooks | Passed |

`tests/unit/project-workspace.test.ts` was updated and committed with the feature. It covers explicit `activeTab`/`gitOpen`, singleton activation, close/fallback behavior, project isolation, retained view preferences, pruning and ignored late updates. Reducer tests do not verify actual React remounts.

The earlier implementation notes also record inspection of the existing Windows development window: syntax and word highlighting, split/unified modes, wrapping, a 390px container, back focus, and file-pane width retention after resize/refresh. Synthetic pointer and keyboard resizing were observed; native WebDriver pointer actions did not establish physical mouse/touch correctness. Loading skeleton visual acceptance was not completed.

The later `1783432` bundle change is identified here for traceability only; the above October 20 counts must not be attributed to that later revision or current HEAD.

## Acceptance criteria disposition

| Criteria | Evidence and remaining limit |
| --- | --- |
| AC1: singleton Git tab, close/reopen | Reducer coverage passed; complete native keyboard/focus acceptance remains unverified |
| AC2: workspace isolation and retained chat/files | Reducer coverage and source review; live-response switching and component-remount acceptance remain incomplete |
| AC3: correct read-only changes/diffs | Windows rendering inspection exists; full staged/untracked/rename/delete/binary/clean/error/refresh matrix is not established |
| AC4: right-sidebar removal | Removal is committed; shared layout/source review recorded, independent backend APIs retained |
| AC5: wide/narrow/touch and Git-free WebUI | Partial Windows container inspection and native-gate source review; full WebUI and physical input acceptance is not established |
| AC6: Local/WSL/SSH connection routing | Source review and compilation passed; real three-environment runtime acceptance is not established |

## Remaining verification

- Complete Windows desktop checks for live chat retention, actual remounts, project/session switches, stale reads and close/focus behavior.
- Check Local/WSL/SSH reads, repository subdirectories, literal pathspecs, clean/disconnected/error states and all relevant file-change kinds.
- Check loading skeletons, physical mouse/touch resizing, theme/font changes and large virtualized diffs; confirm WebUI remains Git-free.
- Revalidate the later highlighting bundle separately when verification is requested.

## Work performed during archiving

Only historical evidence, committed test coverage and task/spec documentation were reconciled. No application/test code was changed; no tests, builds, desktop app or browser checks were run during this archive operation. The user requested archiving, not a new Git commit or push.
