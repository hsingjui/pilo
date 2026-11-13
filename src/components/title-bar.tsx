import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Pin, Square, SquareSquare, X } from "lucide-react";

// 仅在 Tauri 环境生效的标记，避免普通浏览器里出现无意义的留白。
const IS_TAURI = "__TAURI_INTERNALS__" in window;

// macOS：保留原生红绿灯，仅隐藏标题栏文本（tauri.conf.json 的 hiddenTitle + Overlay），
// 内容延伸至窗口顶部，因此侧边栏/顶栏需要为红绿灯预留左侧安全区。
export const IS_MACOS = IS_TAURI && navigator.userAgent.includes("Mac");

// Windows：WSL 与自绘标题栏依赖该平台判断。
export const IS_WINDOWS = IS_TAURI && navigator.userAgent.includes("Windows");

/** macOS 侧栏收起时，通用顶栏避让原生交通灯簇；会话顶栏与 Lody 一致使用 4.5rem。 */
export const TRAFFIC_LIGHT_GUTTER = "pl-[4.5rem]";

/**
 * tauri/tao 的 trafficLightPosition.y = 25 使原生红绿灯圆心距窗口顶部 23px。
 * 顶栏 h-11 和侧栏按钮容器 h-7 会随根字号缩放，因此不能固定补 1px/-2px。
 */
export const TRAFFIC_LIGHT_ALIGNED_HEADER = "mt-[calc(23px-1.375rem)]";

/** 侧栏按钮容器以同一个 23px 圆心定位，扣除主题顶部内缩和容器半高。 */
export const TRAFFIC_LIGHT_ALIGNED_SIDEBAR_ACTIONS =
	"top-[calc(23px-var(--pilo-sidebar-header-top-inset)-0.875rem)]";

// 自定义标题栏仅在 Windows 且运行于 Tauri 时启用（Windows 无边框 + 自绘控制按钮）
export const CUSTOM_TITLEBAR =
	IS_TAURI && navigator.userAgent.includes("Windows");

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
	const { t } = useTranslation();
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
			<CaptionButton
				label={t("app.minimizeWindow")}
				onClick={() => win.minimize()}
			>
				{CAPTION_MIN}
			</CaptionButton>
			<CaptionButton
				label={maximized ? t("app.restoreWindow") : t("app.maximizeWindow")}
				onClick={() => win.toggleMaximize()}
			>
				{maximized ? CAPTION_RESTORE : CAPTION_MAX}
			</CaptionButton>
			<CaptionButton
				label={t("app.closeWindow")}
				danger
				onClick={() => win.close()}
			>
				{CAPTION_CLOSE_ICON}
			</CaptionButton>
		</div>
	);
}

/** 会话窗口专用：切换窗口置顶（always on top）。 */
function AlwaysOnTopButton() {
	const { t } = useTranslation();
	const win = getCurrentWindow();
	const [onTop, setOnTop] = useState(false);
	useEffect(() => {
		void win.isAlwaysOnTop().then(setOnTop);
	}, [win]);
	return (
		<CaptionButton
			label={onTop ? t("app.unpinWindow") : t("app.pinWindow")}
			onClick={() => {
				const next = !onTop;
				setOnTop(next);
				void win.setAlwaysOnTop(next);
			}}
		>
			<Pin size={15} className={onTop ? "text-primary" : undefined} />
		</CaptionButton>
	);
}

export function TitleBar({
	showAlwaysOnTop = false,
}: {
	showAlwaysOnTop?: boolean;
}) {
	return (
		<div className="pointer-events-none absolute right-0 top-0 z-50 h-10">
			<div className="pointer-events-auto flex h-full items-stretch">
				{showAlwaysOnTop ? <AlwaysOnTopButton /> : null}
				<WindowControls />
			</div>
		</div>
	);
}
