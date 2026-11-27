import {
	Clipboard,
	cleanup,
	effect,
	keymap,
	platform,
	signal,
	untracked,
	View,
	type ViewRef,
} from "nsh";
import { Terminal, type TerminalRef } from "nsh/base";

import { getMonospaceFontFamilyStack } from "@shared/font-settings";
import type { HostPreferenceValues } from "@shared/host-preferences-types";
import type { TerminalStore, TerminalTab } from "../state/terminal-store";
import { writeClipboardText } from "../ui/clipboard";
import { useEnterFade } from "../ui/motion";
import { t } from "./i18n";
import {
	encodeTerminalPaste,
	SIGINT_BYTES,
	TerminalBracketedPasteTracker,
} from "./terminal-clipboard";

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
	let containerRef: ViewRef | undefined;
	const focused = signal(false);
	const selectedText = signal("");
	const bracketedPaste = new TerminalBracketedPasteTracker();
	const waiting: string[] = [];
	const show = (text: string) => {
		bracketedPaste.feed(text);
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
	const copySelection = () => {
		const text = untracked(selectedText);
		if (!text) return false;
		selectedText.set("");
		containerRef?.clearSelection();
		void writeClipboardText(text).catch((error: unknown) => {
			console.warn("Failed to copy terminal selection", error);
		});
		return true;
	};
	let focusVersion = 0;
	let focusArmed = false;
	const focusSoon = () => {
		if (!focusArmed) return;
		const version = ++focusVersion;
		setTimeout(() => {
			if (version === focusVersion && props.visible()) ref?.focus();
		}, 0);
	};
	cleanup(() => {
		focusVersion += 1;
	});
	const pasteFromClipboard = async () => {
		try {
			const text = await Clipboard.readText();
			if (!text || !untracked(props.visible) || !untracked(focused)) return;
			const payload = encodeTerminalPaste(text, bracketedPaste.active);
			props.store.write(id, encoder.encode(payload));
		} catch (error: unknown) {
			console.warn("Failed to paste into terminal", error);
		}
	};
	cleanup(
		props.store.attach(id, {
			output: (data) =>
				show(decoder.decode(fromBase64(data), { stream: true })),
			outputTruncated: () => {
				flush();
				show(`\r\n[${t("terminal.outputTruncated")}]\r\n`);
			},
			exit: () => {
				flush();
				show(`\r\n[${t("terminal.processExited")}]\r\n`);
			},
			error: (message) => {
				flush();
				show(`\r\n[${t("terminal.terminalError", { message })}]\r\n`);
			},
		}),
	);
	effect(() => {
		if (props.visible()) {
			focusArmed = true;
			untracked(() => ref?.focus());
			focusSoon();
			return;
		}
		focusArmed = false;
		focusVersion += 1;
		untracked(() => {
			selectedText.set("");
			containerRef?.clearSelection();
		});
	});
	effect(() => {
		if (!props.visible()) return;
		const isFocused = focused();
		const hasSelection = selectedText().length > 0;
		if (!isFocused && !hasSelection) return;
		const copyBindings = {
			"ctrl+c": () => {
				if (!copySelection() && isFocused) {
					props.store.write(id, SIGINT_BYTES);
				}
			},
			"ctrl+shift+c": () => {
				copySelection();
			},
		};
		const paste = () => void pasteFromClipboard();
		const bindings = isFocused
			? {
					...copyBindings,
					// Outside Windows, Ctrl+V is a control key for the terminal program.
					...(platform.os === "windows" && { "ctrl+v": paste }),
					"ctrl+shift+v": paste,
				}
			: copyBindings;
		cleanup(
			keymap.bind(bindings, {
				when: isFocused ? "always" : "notEditing",
				overFocused: true,
			}),
		);
	});
	const fade = useEnterFade(props.visible);
	return (
		<View
			ref={(node) => {
				containerRef = node;
			}}
			testID={`terminal:${id}`}
			selectable
			onSelectionChange={({ text }) => {
				selectedText.set(text);
			}}
			onFocusIn={() => {
				focusArmed = false;
				focused.set(true);
			}}
			onFocusOut={() => focused.set(false)}
			class="absolute inset-0 bg-background pt-1.5 pr-1 pb-1.5 pl-3"
			style={[
				fade.style,
				// Keep layout intact while hidden: `display: none` reports a 0x0
				// frame to `nsh/base`'s Terminal, which clamps it to 1x1 and
				// truncates every screen row to one column.
				{
					visibility: props.visible() ? "visible" : "hidden",
					pointerEvents: props.visible() ? "auto" : "none",
				},
			]}
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
				onLayout={focusSoon}
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
			style={{
				visibility: props.shown() ? "visible" : "hidden",
				pointerEvents: props.shown() ? "auto" : "none",
			}}
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
