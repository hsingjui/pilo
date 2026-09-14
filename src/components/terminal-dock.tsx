/* oxlint-disable jsx-a11y/prefer-tag-over-role -- 终端高度拖拽手柄是水平分割线，role=separator 语义正确，无对应语义 HTML 元素 */
import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
} from "react";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { ChevronDown, ChevronUp, Plus, TerminalSquare, X } from "lucide-react";
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
};

type TerminalLayout = {
	expanded: boolean;
	height: number;
};

const TERMINAL_LAYOUT_KEY = "pilo.terminal.layout.v1";
const DEFAULT_TERMINAL_HEIGHT = 260;
const MIN_TERMINAL_HEIGHT = 140;
const MAX_TERMINAL_HEIGHT = 640;
const TERMINAL_HEADER_HEIGHT = 34;

/** 方向键每次调整的高度。 */
const TERMINAL_RESIZE_STEP = 16;

function readTerminalLayout(): TerminalLayout {
	try {
		const raw = window.localStorage.getItem(TERMINAL_LAYOUT_KEY);
		if (!raw) return { expanded: false, height: DEFAULT_TERMINAL_HEIGHT };
		const value = JSON.parse(raw) as Partial<TerminalLayout>;
		return {
			expanded: value.expanded === true,
			height: Math.min(
				MAX_TERMINAL_HEIGHT,
				Math.max(MIN_TERMINAL_HEIGHT, value.height ?? DEFAULT_TERMINAL_HEIGHT),
			),
		};
	} catch {
		return { expanded: false, height: DEFAULT_TERMINAL_HEIGHT };
	}
}

function persistTerminalLayout(layout: TerminalLayout) {
	window.localStorage.setItem(TERMINAL_LAYOUT_KEY, JSON.stringify(layout));
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
	const { terminalFontFamily, terminalCustomFontFamily, terminalFontSize } =
		usePreferences();
	const initialTerminalFontRef = useRef({
		terminalFontFamily,
		terminalCustomFontFamily,
		terminalFontSize,
	});
	const hostRef = useRef<HTMLDivElement>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const terminalRef = useRef<Terminal | null>(null);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const style = window.getComputedStyle(host);
		const initialFont = initialTerminalFontRef.current;
		const terminal = new Terminal({
			cursorBlink: true,
			fontFamily: getMonospaceFontFamilyStack(
				initialFont.terminalFontFamily,
				initialFont.terminalCustomFontFamily,
			),
			fontSize: initialFont.terminalFontSize,
			lineHeight: 1.15,
			scrollback: 10_000,
			allowTransparency: true,
			theme: {
				background: style.backgroundColor,
				foreground: style.color,
				cursor: style.color,
			},
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

		return () => {
			observer.disconnect();
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
		terminal.options.fontFamily = getMonospaceFontFamilyStack(
			terminalFontFamily,
			terminalCustomFontFamily,
		);
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
	}, [terminalCustomFontFamily, terminalFontFamily, terminalFontSize, tab.id]);

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

export function TerminalDock({ project }: { project?: Project }) {
	const [layout, setLayout] = useState<TerminalLayout>(readTerminalLayout);
	const [tabs, setTabs] = useState<TerminalTab[]>([]);
	const [activeId, setActiveId] = useState<string | null>(null);
	const [opening, setOpening] = useState(false);
	const [listenerReady, setListenerReady] = useState(false);
	const terminalsRef = useRef(new Map<string, Terminal>());
	const pendingOutputRef = useRef(new Map<string, Uint8Array[]>());
	const exitedRef = useRef(new Set<string>());

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
		updateLayout({ ...layout, expanded: true });
		try {
			const info = await openProjectTerminal(project.id);
			setTabs((current) => [...current, info]);
			setActiveId(info.id);
		} catch (error) {
			toast.error("无法打开 Terminal", {
				description: userErrorMessage(error),
			});
		} finally {
			setOpening(false);
		}
	}, [layout, listenerReady, opening, updateLayout, project]);

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

	const handleResizeStart = useCallback(
		(event: ReactPointerEvent<HTMLDivElement>) => {
			if (!layout.expanded) return;
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
		[layout.expanded, layout.height],
	);

	const handleResizeKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>) => {
			if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
			event.preventDefault();
			if (!layout.expanded) return;
			updateLayout({
				expanded: true,
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
		[layout.expanded, layout.height, updateLayout],
	);

	const toggleExpanded = useCallback(() => {
		const next = { ...layout, expanded: !layout.expanded };
		updateLayout(next);
	}, [layout, updateLayout]);

	return (
		<section
			className="relative flex shrink-0 flex-col border-t border-border bg-background"
			style={{
				height: layout.expanded ? layout.height : TERMINAL_HEADER_HEIGHT,
			}}
		>
			{layout.expanded ? (
				<div
					role="separator"
					aria-orientation="horizontal"
					aria-label="调整终端高度"
					tabIndex={0}
					aria-valuemin={MIN_TERMINAL_HEIGHT}
					aria-valuemax={MAX_TERMINAL_HEIGHT}
					aria-valuenow={Math.round(layout.height)}
					onPointerDown={handleResizeStart}
					onKeyDown={handleResizeKeyDown}
					className="absolute -top-1 left-0 right-0 z-10 h-2 cursor-row-resize focus-visible:outline-hidden after:absolute after:inset-x-0 after:top-1/2 after:h-[2px] after:-translate-y-1/2 after:bg-transparent hover:after:bg-sidebar-ring/50 focus-visible:after:bg-sidebar-ring"
				/>
			) : null}
			<header className="flex h-[34px] shrink-0 select-none items-center gap-1 border-b border-border/70 px-2">
				<button
					type="button"
					className="flex h-7 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground"
					onClick={toggleExpanded}
				>
					<TerminalSquare className="size-3.5" />
					Terminal
					{layout.expanded ? (
						<ChevronDown className="size-3" />
					) : (
						<ChevronUp className="size-3" />
					)}
				</button>
				{tabs.map((tab, index) => (
					<div
						key={tab.id}
						className={cn(
							"group/tab flex min-w-0 max-w-48 items-center rounded-md text-[11px] text-muted-foreground",
							activeId === tab.id && "bg-muted text-foreground",
						)}
					>
						<button
							type="button"
							className="min-w-0 flex-1 truncate px-2 py-1"
							onClick={() => {
								setActiveId(tab.id);
								if (!layout.expanded)
									updateLayout({ ...layout, expanded: true });
							}}
						>
							{tab.title} {index + 1}
							{tab.exited ? " · exited" : ""}
						</button>
						<button
							type="button"
							className="mr-1 rounded p-1.5 opacity-0 hover:bg-background group-hover/tab:opacity-100 focus-visible:opacity-100"
							aria-label="关闭 Terminal"
							onClick={() => closeTab(tab.id)}
						>
							<X className="size-3" />
						</button>
					</div>
				))}
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="size-7"
					aria-label="新建 Terminal"
					disabled={!project || opening || !listenerReady}
					onClick={() => void openTab()}
				>
					<Plus className="size-3.5" />
				</Button>
				{project ? (
					<span className="ml-auto hidden max-w-56 truncate text-[11px] text-muted-foreground lg:block">
						{project.connection.name} · {project.path}
					</span>
				) : null}
			</header>
			{layout.expanded ? (
				<div className="min-h-0 flex-1">
					{tabs.length === 0 ? (
						<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
							{project
								? "点击 + 在当前项目新建 Terminal"
								: "选择项目后可打开 Terminal"}
						</div>
					) : (
						tabs.map((tab) => (
							<TerminalViewport
								key={tab.id}
								tab={tab}
								active={tab.id === activeId}
								onRegister={registerTerminal}
							/>
						))
					)}
				</div>
			) : null}
		</section>
	);
}
