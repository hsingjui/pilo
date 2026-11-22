import { cleanup, effect, untracked, View } from "nsh";
import { Terminal, type TerminalRef } from "nsh/base";

import { getMonospaceFontFamilyStack } from "@shared/font-settings";
import type { HostPreferenceValues } from "@shared/host-preferences-types";
import type { TerminalStore, TerminalTab } from "../state/terminal-store";
import { t } from "./i18n";

function fromBase64(data: string) {
	const text = atob(data);
	const bytes = new Uint8Array(text.length);
	for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
	return bytes;
}

/**
 * One terminal tab: nsh's terminal emulator on the project's shell. It
 * stays mounted while hidden, so the screen and scrollback survive
 * switching tabs.
 */
function TerminalView(props: {
	tab: TerminalTab;
	store: TerminalStore;
	visible: () => boolean;
	preferences: () => HostPreferenceValues | undefined;
}) {
	const id = props.tab.id;
	let ref: TerminalRef | undefined;
	const waiting: string[] = [];
	const show = (text: string) => {
		if (ref) ref.write(text);
		else waiting.push(text);
	};
	// The shell's UTF-8 can split a character across output chunks.
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	const flush = () => {
		const rest = decoder.decode();
		if (rest) show(rest);
	};
	cleanup(
		props.store.attach(id, {
			output: (data) =>
				show(decoder.decode(fromBase64(data), { stream: true })),
			exit: () => {
				flush();
				show("\r\n[process exited]\r\n");
			},
			error: (message) => {
				flush();
				show(`\r\n[terminal error] ${message}\r\n`);
			},
		}),
	);
	effect(() => {
		if (props.visible()) untracked(() => ref?.focus());
	});
	return (
		<View
			testID={`terminal:${id}`}
			class="absolute inset-0 bg-background pt-1.5 pr-1 pb-1.5 pl-3"
			style={{ display: props.visible() ? "flex" : "none" }}
		>
			<Terminal
				ref={(node) => {
					ref = node;
					for (const text of waiting.splice(0)) node.write(text);
					if (props.visible()) node.focus();
				}}
				class="flex-1 bg-background"
				scrollback={10_000}
				fontFamily={getMonospaceFontFamilyStack(
					props.preferences()?.terminalFontFamily ?? "system-mono",
				)}
				fontSize={props.preferences()?.terminalFontSize ?? 13}
				cursorClass="bg-foreground/60"
				accessibilityLabel={t("terminal.show")}
				onData={({ data }) => props.store.write(id, encoder.encode(data))}
				onResize={({ cols, rows }) => {
					if (cols > 0 && rows > 0) props.store.resize(id, cols, rows);
				}}
			/>
		</View>
	);
}

/**
 * Every terminal's view, over the workspace while one of them is in front
 * of the chat; the others stay mounted, hidden.
 */
export function TerminalLayer(props: {
	terminals: TerminalStore;
	/** The terminal in front, or `null` while the chat is. */
	shown: () => string | null;
	preferences: () => HostPreferenceValues | undefined;
}) {
	return (
		<View
			testID="terminal-layer"
			class="absolute inset-0 z-30 bg-background"
			style={{ display: props.shown() ? "flex" : "none" }}
		>
			<Each of={props.terminals.tabs()} key={(tab) => tab.id}>
				{(tab) => (
					<TerminalView
						tab={tab()}
						store={props.terminals}
						visible={() => props.shown() === tab().id}
						preferences={props.preferences}
					/>
				)}
			</Each>
		</View>
	);
}
