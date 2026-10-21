# Desktop WSL/SSH file links

## Goal
Allow user-activated Markdown file URLs in saved WSL/SSH projects to preview text/code or open allowlisted documents without a separate HTTP server.

## Scope
- Preserve Local file-link behavior and the existing shared file chips/workspace tabs.
- Parse URLs independently of desktop host path semantics before remote access.
- Read remote files through the selected connection using a bounded, read-only server capability.
- Keep text previews at 1 MiB; bound document transfers by the binary transport limit.
- Check original/canonical document extensions, executable bits and executable signatures.
- Open remote documents as disposable local cache snapshots; do not synchronize project directories or HTML dependencies.
- Preserve the HTML-only legacy command and the WebUI native-opening guard; add no generic WebUI filesystem endpoint.

## Change boundary
Frontend: remove the two desktop-only remote guards, retain the WebUI guard.
Runtime: environment-neutral URL validation, remote read/preview/cache/open path.
Server/protocol: add file_link.read with shared document safety checks.
Specs: update the file-link contract and pending verification matrix.

## Validation
Tests and builds require explicit user authorization, which was subsequently given. Updated browser/protocol tests and implementation are committed in `d6498c0`. Recovered frontend/Node/Rust results and file-link browser checks passed; the broader shared workspace browser fixture has recorded unresolved layout assertion failures. Native Windows and real WSL/SSH acceptance remain incomplete. See [acceptance.md](./acceptance.md) for evidence, exact limitations and historical session references.

## Archive status
Archived on 2026-10-21 at the user's request, with incomplete and failed verification scenarios explicitly retained in acceptance.md. No tests or builds were rerun during archiving. The checkout lacks project-local task scripts; the installed Trellis archive command is used with `--no-commit`, without changing the workflow runtime.
