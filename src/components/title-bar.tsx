import { useEffect, useState, type ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, SquareSquare, X } from "lucide-react";

// 自定义标题栏仅在 Windows 且运行于 Tauri 时启用（macOS 保留原生窗口装饰）
export const CUSTOM_TITLEBAR =
	navigator.userAgent.includes("Windows") && "__TAURI_INTERNALS__" in window;

const CAPTION_BUTTON =
	"mx-1 my-1 flex h-[calc(100%-0.5rem)] w-8 items-center justify-center rounded-md text-foreground/75 transition-colors hover:bg-foreground/5 hover:text-foreground";
const CAPTION_CLOSE = "hover:bg-destructive hover:text-destructive-foreground";

function CaptionButton({
	label,
	onClick,
	danger,
	children,
}: {
	label: string;
	onClick: () => void;
	danger?: boolean;
	children: ReactNode;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			onClick={onClick}
			className={`${CAPTION_BUTTON} ${danger ? CAPTION_CLOSE : ""}`}
		>
			{children}
		</button>
	);
}

// Windows 原生 caption 图标：最小化/最大化/还原/关闭
const CAPTION_MIN = <Minus size={15} />;
const CAPTION_MAX = <Square size={14} />;
const CAPTION_RESTORE = <SquareSquare size={14} />;
const CAPTION_CLOSE_ICON = <X size={15} />;

function WindowControls() {
	const win = getCurrentWindow();
	const [maximized, setMaximized] = useState(false);
	useEffect(() => {
		let unlisten: (() => void) | undefined;
		win.isMaximized().then(setMaximized);
		win
			.onResized(() => {
				win.isMaximized().then(setMaximized);
			})
			.then((fn) => (unlisten = fn));
		return () => unlisten?.();
	}, [win]);
	return (
		<div className="flex h-full items-stretch">
			<CaptionButton label="最小化" onClick={() => win.minimize()}>
				{CAPTION_MIN}
			</CaptionButton>
			<CaptionButton
				label={maximized ? "还原" : "最大化"}
				onClick={() => win.toggleMaximize()}
			>
				{maximized ? CAPTION_RESTORE : CAPTION_MAX}
			</CaptionButton>
			<CaptionButton label="关闭" danger onClick={() => win.close()}>
				{CAPTION_CLOSE_ICON}
			</CaptionButton>
		</div>
	);
}

export function TitleBar() {
	return (
		<div className="pointer-events-none absolute right-0 top-0 z-50 h-10">
			<div className="pointer-events-auto h-full">
				<WindowControls />
			</div>
		</div>
	);
}
