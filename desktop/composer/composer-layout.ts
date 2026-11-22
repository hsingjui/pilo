import { token } from "nsh";

import { chatPx, DEFAULT_CHAT_REM } from "../chat/layout";

/** nsh resolves rem to 16pt; match Tauri's default rem inside the composer. */
const composerControlHeight = () => chatPx(token("pilo-composer-control-size"));
export const composerToolbarGap = () =>
	chatPx(token("pilo-composer-toolbar-gap"));

export function composerToolButtonSize() {
	return {
		height: composerControlHeight(),
		width: chatPx(token("pilo-composer-attachment-width")),
	};
}

export function composerSendSize() {
	const size = composerControlHeight();
	return { width: size, height: size };
}

export function composerSendModeStyle() {
	return {
		height: composerControlHeight(),
		gap: chatPx(4),
		paddingHorizontal: chatPx(6),
		paddingVertical: 0,
	};
}

export function composerActionsGap(toolbarWidth: number) {
	return chatPx(toolbarWidth < 40 * DEFAULT_CHAT_REM ? 2 : 6);
}

export function composerRunConfigStyle(toolbarWidth: number) {
	const compact = toolbarWidth < 24 * DEFAULT_CHAT_REM;
	return {
		height: composerControlHeight(),
		marginLeft: -chatPx(4),
		gap: chatPx(compact ? 2 : 4),
		paddingHorizontal: compact ? 0 : chatPx(8),
	};
}
