/* oxlint-disable jsx-a11y/prefer-tag-over-role -- 终端高度拖拽手柄是水平分割线，role=separator 语义正确，无对应语义 HTML 元素 */
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { Plus, X } from "lucide-react";
import { toast } from "sonner";

import { userErrorMessage } from "@/lib/app-error";
import { getMonospaceFontFamilyStack } from "@/lib/font-settings";
import { usePreferences } from "@/lib/preferences-provider";
import {
	closeTerminal,
	listenTerminalEvents,
	openProjectTerminal,
	resizeTerminal,
	writeTerminal,
	type TerminalEvent,
	type TerminalInfo,
} from "@/lib/terminal";
import { cn } from "@/lib/utils";
import type { Project } from "@/lib/projects";
import { Button } from "@/ui";

type TerminalTab = TerminalInfo & {
	exited?: boolean;
	renamed?: boolean;
};

type TerminalLayout = {
	height: number;
};

const TERMINAL_LAYOUT_KEY = "pilo.terminal.layout.v1";
const DEFAULT_TERMINAL_HEIGHT = 260;
const MIN_TERMINAL_HEIGHT = 140;
const MAX_TERMINAL_HEIGHT = 640;

/** 方向键每次调整的高度。 */
const TERMINAL_RESIZE_STEP = 16;

function readTerminalLayout(): TerminalLayout {
	try {
		const raw = window.localStorage.getItem(TERMINAL_LAYOUT_KEY);
		if (!raw) return { height: DEFAULT_TERMINAL_HEIGHT };
		const value = JSON.parse(raw) as Partial<TerminalLayout>;
		return {
			height: Math.min(
				MAX_TERMINAL_HEIGHT,
				Math.max(MIN_TERMINAL_HEIGHT, value.height ?? DEFAULT_TERMINAL_HEIGHT),
			),
		};
	} catch {
		return { height: DEFAULT_TERMINAL_HEIGHT };
	}
}

function persistTerminalLayout(layout: TerminalLayout) {
	window.localStorage.setItem(TERMINAL_LAYOUT_KEY, JSON.stringify(layout));
}

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

function TerminalViewport({
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

export function TerminalDock({
	project,
	visible,
	openRequest = 0,
	onRunningChange,
	onDestroy,
}: {
	project?: Project;
	visible: boolean;
	openRequest?: number;
	onRunningChange?: (running: boolean) => void;
	onDestroy?: () => void;
}) {
	const { t } = useTranslation();
	const [layout, setLayout] = useState<TerminalLayout>(readTerminalLayout);
	const [tabs, setTabs] = useState<TerminalTab[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [editingId, setEditingId] = useState<string | null>(null);
	const [titleDraft, setTitleDraft] = useState("");
	const [opening, setOpening] = useState(false);
	const [listenerReady, setListenerReady] = useState(false);
	const lastOpenRequestRef = useRef(0);
	const terminalsRef = useRef(new Map<string, Terminal>());
	const pendingOutputRef = useRef(new Map<string, Uint8Array[]>());
	const exitedRef = useRef(new Set<string>());
	const renameCancelledRef = useRef(false);
	const renameInputRef = useRef<HTMLInputElement>(null);

	const handleTerminalEvent = useCallback((event: TerminalEvent) => {
		const terminal = terminalsRef.current.get(event.terminalId);
		if (event.type === "output") {
			const data = new Uint8Array(event.data);
			if (terminal) {
				terminal.write(data);
			} else {
				const pending = pendingOutputRef.current.get(event.terminalId) ?? [];
				pending.push(data);
				pendingOutputRef.current.set(event.terminalId, pending);
			}
			return;
		}
		if (event.type === "error") {
			terminal?.writeln(`\r\n[terminal error] ${event.message}`);
			return;
		}
		exitedRef.current.add(event.terminalId);
		terminal?.writeln("\r\n[process exited]");
		setTabs((current) =>
			current.map((tab) =>
				tab.id === event.terminalId ? { ...tab, exited: true } : tab,
			),
		);
	}, []);

	useEffect(() => {
		let disposed = false;
		const subscription = listenTerminalEvents(handleTerminalEvent);
		void subscription.then(() => {
			if (!disposed) setListenerReady(true);
		});
		return () => {
			disposed = true;
			void subscription.then((unlisten) => unlisten()).catch(() => undefined);
		};
	}, [handleTerminalEvent]);

	useEffect(() => {
		onRunningChange?.(tabs.some((tab) => !tab.exited));
	}, [onRunningChange, tabs]);

	// 关闭最后一个 tab 时收起整个终端面板。
	const hadTabsRef = useRef(false);
	useEffect(() => {
		if (tabs.length > 0) {
			hadTabsRef.current = true;
			return;
		}
		if (!hadTabsRef.current || !visible) return;
		hadTabsRef.current = false;
		onDestroy?.();
	}, [onDestroy, tabs.length, visible]);

	const registerTerminal = useCallback(
		(terminalId: string, terminal: Terminal | null) => {
			if (!terminal) {
				terminalsRef.current.delete(terminalId);
				return;
			}
			terminalsRef.current.set(terminalId, terminal);
			const pending = pendingOutputRef.current.get(terminalId);
			if (pending) {
				for (const chunk of pending) terminal.write(chunk);
				pendingOutputRef.current.delete(terminalId);
			}
			if (exitedRef.current.has(terminalId)) {
				terminal.writeln("\r\n[process exited]");
			}
		},
		[],
	);

	const updateLayout = useCallback((next: TerminalLayout) => {
		setLayout(next);
		persistTerminalLayout(next);
	}, []);

	const openTab = useCallback(async () => {
		if (!project || opening || !listenerReady) return;
		setOpening(true);
		try {
			const info = await openProjectTerminal(project.id);
			setTabs((current) => [...current, info]);
			setActiveId(info.id);
		} catch (error) {
			toast.error(t("terminal.openFailed"), {
				description: userErrorMessage(error),
			});
		} finally {
			setOpening(false);
		}
	}, [listenerReady, opening, project, t]);

	useEffect(() => {
		if (
			openRequest <= lastOpenRequestRef.current ||
			!project ||
			!listenerReady ||
			opening
		) {
			return;
		}

		const frame = window.requestAnimationFrame(() => {
			lastOpenRequestRef.current = openRequest;

			let existing: TerminalTab | undefined;
			for (let index = tabs.length - 1; index >= 0; index -= 1) {
				const tab = tabs[index];
				if (tab?.projectId === project.id && !tab.exited) {
					existing = tab;
					break;
				}
			}
			if (existing) {
				setActiveId(existing.id);
				window.requestAnimationFrame(() => {
					terminalsRef.current.get(existing.id)?.focus();
				});
				return;
			}

			void openTab();
		});
		return () => window.cancelAnimationFrame(frame);
	}, [listenerReady, openRequest, opening, openTab, project, tabs]);

	const closeTab = useCallback(
		(terminalId: string) => {
			void closeTerminal(terminalId).catch(() => undefined);
			pendingOutputRef.current.delete(terminalId);
			exitedRef.current.delete(terminalId);
			setTabs((current) => {
				const index = current.findIndex((tab) => tab.id === terminalId);
				const next = current.filter((tab) => tab.id !== terminalId);
				if (activeId === terminalId) {
					setActiveId(next[Math.min(index, next.length - 1)]?.id ?? null);
				}
				return next;
			});
		},
		[activeId],
	);

	const startRename = useCallback((tab: TerminalTab) => {
		renameCancelledRef.current = false;
		setTitleDraft(tab.title);
		setEditingId(tab.id);
	}, []);

	useEffect(() => {
		if (editingId) renameInputRef.current?.select();
	}, [editingId]);

	const commitRename = useCallback(() => {
		const id = editingId;
		setEditingId(null);
		if (!id || renameCancelledRef.current) return;
		const title = titleDraft.trim();
		if (!title) return;
		setTabs((current) =>
			current.map((tab) =>
				tab.id === id ? { ...tab, title, renamed: true } : tab,
			),
		);
	}, [editingId, titleDraft]);

	const destroyAll = useCallback(async () => {
		const ids = tabs.map((tab) => tab.id);
		const results = await Promise.allSettled(
			ids.map((id) => closeTerminal(id)),
		);
		pendingOutputRef.current.clear();
		exitedRef.current.clear();
		setTabs([]);
		setActiveId(null);
		onRunningChange?.(false);
		onDestroy?.();

		const failed = results.filter((result) => result.status === "rejected");
		if (failed.length > 0) {
			toast.error(t("terminal.partialCloseFailed"));
		}
	}, [onDestroy, onRunningChange, tabs, t]);

	const handleResizeStart = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			const startY = event.clientY;
			const startHeight = layout.height;
			const onMove = (moveEvent: PointerEvent) => {
				const height = Math.min(
					MAX_TERMINAL_HEIGHT,
					Math.max(
						MIN_TERMINAL_HEIGHT,
						startHeight + startY - moveEvent.clientY,
					),
				);
				const next = { expanded: true, height };
				setLayout(next);
				persistTerminalLayout(next);
			};
			const onUp = () => {
				window.removeEventListener("pointermove", onMove);
				window.removeEventListener("pointerup", onUp);
			};
			window.addEventListener("pointermove", onMove);
			window.addEventListener("pointerup", onUp, { once: true });
		},
		[layout.height],
	);

	const handleResizeKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>) => {
			if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
			event.preventDefault();
			updateLayout({
				height: Math.min(
					MAX_TERMINAL_HEIGHT,
					Math.max(
						MIN_TERMINAL_HEIGHT,
						layout.height +
							(event.key === "ArrowUp"
								? TERMINAL_RESIZE_STEP
								: -TERMINAL_RESIZE_STEP),
					),
				),
			});
		},
		[layout.height, updateLayout],
	);

	return (
		<section
			className={cn(
				"relative shrink-0 flex-col border-t border-border bg-background",
				visible ? "flex" : "hidden",
			)}
			style={{ height: layout.height }}
		>
			<div
				role="separator"
				aria-orientation="horizontal"
				aria-label={t("terminal.resize")}
				tabIndex={0}
				aria-valuemin={MIN_TERMINAL_HEIGHT}
				aria-valuemax={MAX_TERMINAL_HEIGHT}
				aria-valuenow={Math.round(layout.height)}
				onPointerDown={handleResizeStart}
				onKeyDown={handleResizeKeyDown}
				className="absolute -top-1 left-0 right-0 z-10 h-2 cursor-row-resize focus-visible:outline-hidden after:absolute after:inset-x-0 after:top-1/2 after:h-[2px] after:-translate-y-1/2 after:bg-transparent hover:after:bg-sidebar-ring/50 focus-visible:after:bg-sidebar-ring"
			/>
			<header className="flex h-[34px] shrink-0 select-none items-center gap-1 border-b border-border bg-muted/20 pr-1">
				<div className="scrollbar-pro flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
					{tabs.map((tab, index) => (
						<div
							key={tab.id}
							className={cn(
								"flex h-6 max-w-48 shrink-0 items-center rounded-md border border-transparent text-xs text-muted-foreground",
								activeId === tab.id &&
									"border-border bg-background text-foreground",
							)}
						>
							{editingId === tab.id ? (
								<input
									ref={renameInputRef}
									value={titleDraft}
									aria-label={t("terminal.rename")}
									className="mx-1 w-28 min-w-0 rounded bg-background px-1.5 py-0.5 text-xs text-foreground outline-none ring-1 ring-sidebar-ring"
									onChange={(event) => setTitleDraft(event.target.value)}
									onBlur={commitRename}
									onKeyDown={(event) => {
										if (event.key === "Enter") commitRename();
										if (event.key === "Escape") {
											renameCancelledRef.current = true;
											setEditingId(null);
										}
									}}
								/>
							) : (
								<button
									type="button"
									className="min-w-0 truncate rounded-md px-2.5 py-1"
									onClick={() => {
										setActiveId(tab.id);
									}}
									onDoubleClick={() => startRename(tab)}
								>
									{tab.title}
									{tab.renamed ? "" : ` ${index + 1}`}
									{tab.exited ? " · exited" : ""}
								</button>
							)}
							{editingId === tab.id ? null : (
								<button
									type="button"
									className="mr-0.5 rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
									aria-label={t("terminal.close")}
									onClick={() => closeTab(tab.id)}
								>
									<X className="size-3" />
								</button>
							)}
						</div>
					))}
				</div>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-6"
					aria-label={t("terminal.new")}
					disabled={!project || opening || !listenerReady}
					onClick={() => void openTab()}
				>
					<Plus className="size-3.5" />
				</Button>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-6"
					aria-label={t("terminal.destroy")}
					disabled={opening}
					onClick={() => void destroyAll()}
				>
					<X className="size-3.5" />
				</Button>
			</header>
			<div className="min-h-0 flex-1">
				{tabs.length === 0 ? (
					<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
						{project ? t("terminal.newHint") : t("terminal.selectProjectHint")}
					</div>
				) : (
					tabs.map((tab) => (
						<TerminalViewport
							key={tab.id}
							tab={tab}
							active={visible && tab.id === activeId}
							onRegister={registerTerminal}
						/>
					))
				)}
			</div>
		</section>
	);
}
