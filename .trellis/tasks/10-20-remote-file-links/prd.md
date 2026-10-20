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
Review diffs and trace Local/WSL/SSH callers. No tests are created/modified or run, and no builds are run without explicit user authorization. Native Windows and real SSH verification remain pending.

The checkout lacks the documented Trellis task scripts; this task artifact is maintained directly without changing the workflow runtime.
