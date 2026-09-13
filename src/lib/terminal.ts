import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type TerminalInfo = {
	id: string;
	projectId: string;
	title: string;
};

export type TerminalEvent =
	| { type: "output"; terminalId: string; data: number[] }
	| { type: "exit"; terminalId: string }
	| { type: "error"; terminalId: string; message: string };

export function openProjectTerminal(
	projectId: string,
	cols = 80,
	rows = 24,
): Promise<TerminalInfo> {
	return invoke("project_terminal_open", { id: projectId, cols, rows });
}

export function writeTerminal(
	terminalId: string,
	data: Uint8Array,
): Promise<void> {
	return invoke("terminal_write", {
		terminalId,
		data: Array.from(data),
	});
}

export function resizeTerminal(
	terminalId: string,
	cols: number,
	rows: number,
): Promise<void> {
	return invoke("terminal_resize", { terminalId, cols, rows });
}

export function closeTerminal(terminalId: string): Promise<void> {
	return invoke("terminal_close", { terminalId });
}

export function listenTerminalEvents(
	handler: (event: TerminalEvent) => void,
): Promise<UnlistenFn> {
	return listen<TerminalEvent>("pilo://terminal", (event) =>
		handler(event.payload),
	);
}
