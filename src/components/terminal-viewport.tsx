import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";

import { getMonospaceFontFamilyStack } from "@/lib/font-settings";
import { usePreferences } from "@/lib/preferences-provider";
import {
	resizeTerminal,
	writeTerminal,
	type TerminalInfo,
} from "@/lib/terminal";
import { cn } from "@/lib/utils";

export type TerminalTab = TerminalInfo & {
	exited?: boolean;
	renamed?: boolean;
};

/*
 * xterm 只接受 hex / rgb() / rgba() 颜色，且半透明必须用逗号语法：空格语法会走
 * canvas 解析，alpha < 1 时抛 "Unsupported css format"。默认选中色是
 * rgba(255,255,255,.3) 叠在底色上，浅色主题下与白色底几乎同色，选中了也看不出来，
 * 所以用前景色自己叠一层，浅色和深色主题下都可见。
 */
function terminalSelectionColor(foreground: string): string {
	const channels = foreground.match(/\d+/g);
	if (!channels) return "rgba(127, 127, 127, 0.35)";
	return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, 0.35)`;
}

/*
 * xterm 的主题是构造时的静态值，之后不会跟着 CSS 变量走，主题翻转时必须重读。
 * 颜色全部从宿主元素现算，不依赖 useTheme：终端在 .dark 下自然就是深色底，
 * 也就不会出现「上下文和实际 DOM 不一致」时把终端刷成反色的情况。
 */
function readTerminalTheme(host: HTMLElement) {
	const style = window.getComputedStyle(host);
	return {
		background: style.backgroundColor,
		foreground: style.color,
		cursor: style.color,
		selectionBackground: terminalSelectionColor(style.color),
	};
}

export function TerminalViewport({
	tab,
	active,
	onRegister,
}: {
	tab: TerminalTab;
	active: boolean;
	onRegister: (terminalId: string, terminal: Terminal | null) => void;
}) {
	const { terminalFontFamily, terminalFontSize } = usePreferences();
	const initialTerminalFontRef = useRef({
		terminalFontFamily,
		terminalFontSize,
	});
	const hostRef = useRef<HTMLDivElement>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const terminalRef = useRef<Terminal | null>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const initialFont = initialTerminalFontRef.current;
		const terminal = new Terminal({
			cursorBlink: true,
			fontFamily: getMonospaceFontFamilyStack(initialFont.terminalFontFamily),
			fontSize: initialFont.terminalFontSize,
			lineHeight: 1.15,
			scrollback: 10_000,
			allowTransparency: true,
			theme: readTerminalTheme(host),
		});
		// WebView2 下 canvas 选区不一定能触发原生 copy 事件，这里显式接管
		// Ctrl/Cmd+C：有选区就复制，没有选区照旧透传给 shell（SIGINT）。
		terminal.attachCustomKeyEventHandler((event) => {
			if (event.type !== "keydown" || event.altKey) return true;
			if (!(event.ctrlKey || event.metaKey)) return true;
			if (event.key.toLowerCase() !== "c") return true;
			if (!terminal.hasSelection()) return true;
			void navigator.clipboard
				.writeText(terminal.getSelection())
				.catch(() => undefined);
			return false;
		});
		const fit = new FitAddon();
		terminal.loadAddon(fit);
		terminal.open(host);
		terminalRef.current = terminal;
		fitRef.current = fit;
		onRegister(tab.id, terminal);

		const input = terminal.onData((data) => {
			void writeTerminal(tab.id, new TextEncoder().encode(data)).catch(
				() => undefined,
			);
		});
		const observer = new ResizeObserver(() => {
			if (host.clientWidth <= 0 || host.clientHeight <= 0) return;
			fit.fit();
			void resizeTerminal(tab.id, terminal.cols, terminal.rows).catch(
				() => undefined,
			);
		});
		observer.observe(host);

		// 主题切换只改 <html> 上的 dark/light 类，xterm 感知不到，重读一次即可。
		const themeObserver = new MutationObserver(() => {
			terminal.options.theme = readTerminalTheme(host);
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class"],
		});

		return () => {
			observer.disconnect();
			themeObserver.disconnect();
			input.dispose();
			onRegister(tab.id, null);
			terminal.dispose();
			terminalRef.current = null;
			fitRef.current = null;
		};
	}, [onRegister, tab.id]);

	useEffect(() => {
		const terminal = terminalRef.current;
		const fit = fitRef.current;
		const host = hostRef.current;
		if (!terminal) return;
		terminal.options.fontFamily =
			getMonospaceFontFamilyStack(terminalFontFamily);
		terminal.options.fontSize = terminalFontSize;
		if (!fit || !host || host.clientWidth <= 0 || host.clientHeight <= 0)
			return;
		const frame = window.requestAnimationFrame(() => {
			fit.fit();
			void resizeTerminal(tab.id, terminal.cols, terminal.rows).catch(
				() => undefined,
			);
		});
		return () => window.cancelAnimationFrame(frame);
	}, [terminalFontFamily, terminalFontSize, tab.id]);

	useEffect(() => {
		if (!active) return;
		const frame = window.requestAnimationFrame(() => {
			const terminal = terminalRef.current;
			const fit = fitRef.current;
			const host = hostRef.current;
			if (
				!terminal ||
				!fit ||
				!host ||
				host.clientWidth <= 0 ||
				host.clientHeight <= 0
			) {
				return;
			}
			fit.fit();
			terminal.focus();
			void resizeTerminal(tab.id, terminal.cols, terminal.rows).catch(
				() => undefined,
			);
		});
		return () => window.cancelAnimationFrame(frame);
	}, [active, tab.id]);

	return (
		<div
			ref={hostRef}
			className={cn(
				"h-full min-h-0 w-full bg-background px-2 py-1.5 text-foreground",
				!active && "hidden",
			)}
		/>
	);
}
