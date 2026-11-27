/**
 * Shared Host API type re-exports kept for callers (such as Remote WebUI v1)
 * that still import transcript or terminal types from `app/client/host-api`.
 * Desktop code imports `HostClient` from `@shared/api/host-client` directly.
 */
export type {
	ChatTranscriptSnapshot,
	ChatTranscriptWindow,
	HostBootstrap as DesktopHostBootstrap,
	TerminalEvent,
	TerminalInfo,
	TerminalSnapshot,
} from "@shared/api/host-methods";
