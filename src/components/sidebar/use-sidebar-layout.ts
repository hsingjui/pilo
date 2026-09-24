import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type KeyboardEvent as ReactKeyboardEvent,
	type PointerEvent as ReactPointerEvent,
} from "react";

/** 侧栏最小宽度：低于该值拖拽视为折叠（拖到 MIN 后调用 onCollapse）。 */
export const MIN_SIDEBAR_WIDTH = 240;

/** 侧栏最大宽度。 */
export const MAX_SIDEBAR_WIDTH = 480;

/** 侧栏默认宽度。 */
const DEFAULT_SIDEBAR_WIDTH = 292;

/** 方向键每次调整的宽度。 */
const RESIZE_STEP = 16;

/** 侧栏宽度持久化 key。 */
const SIDEBAR_WIDTH_STORAGE_KEY = "pilo.sidebarWidth";

/**
 * 侧栏宽度、拖拽/键盘调整与折叠状态。拖到最小宽度以下即折叠；
 * `settledCollapsed` 记录“已完成过渡的折叠状态”，用于在展开动画期间隐藏头部按钮。
 */
export function useSidebarLayout({
	collapsed,
	onCollapse,
}: {
	collapsed: boolean;
	onCollapse?: () => void;
}) {
	const asideRef = useRef<HTMLElement>(null);
	const [settledCollapsed, setSettledCollapsed] = useState(collapsed);
	const [sidebarWidth, setSidebarWidth] = useState(() => {
		const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
		if (!stored) return DEFAULT_SIDEBAR_WIDTH;
		const parsed = Number.parseInt(stored, 10);
		if (!Number.isFinite(parsed)) return DEFAULT_SIDEBAR_WIDTH;
		return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, parsed));
	});
	const [resizing, setResizing] = useState(false);

	useEffect(() => {
		window.localStorage.setItem(
			SIDEBAR_WIDTH_STORAGE_KEY,
			String(sidebarWidth),
		);
	}, [sidebarWidth]);

	// 收起时立即隐藏；展开时等宽度过渡（200ms）结束再显示。
	useEffect(() => {
		const timer = window.setTimeout(() => setSettledCollapsed(collapsed), 220);
		return () => window.clearTimeout(timer);
	}, [collapsed]);

	const startResize = useCallback(
		(event: ReactPointerEvent) => {
			event.preventDefault();
			const aside = asideRef.current;
			if (!aside) return;
			const startX = event.clientX;
			const startWidth = aside.getBoundingClientRect().width;
			// 折叠需要比最小宽度再小一截才触发（滞后带），
			// 避免在最小宽度时按下/轻微抖动就误折叠、无法向外拖。
			const collapseAt = MIN_SIDEBAR_WIDTH - 8;
			const handleMove = (moveEvent: PointerEvent) => {
				const rawWidth = startWidth + (moveEvent.clientX - startX);
				if (rawWidth <= collapseAt) {
					setSidebarWidth(MIN_SIDEBAR_WIDTH);
					onCollapse?.();
					cleanup();
					return;
				}
				setSidebarWidth(
					Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, rawWidth)),
				);
			};
			const cleanup = () => {
				window.removeEventListener("pointermove", handleMove);
				window.removeEventListener("pointerup", cleanup);
				window.removeEventListener("pointercancel", cleanup);
				document.body.classList.remove("select-none");
				setResizing(false);
			};
			window.addEventListener("pointermove", handleMove);
			window.addEventListener("pointerup", cleanup);
			window.addEventListener("pointercancel", cleanup);
			document.body.classList.add("select-none");
			setResizing(true);
		},
		[onCollapse],
	);

	// 键盘路径：←/→ 每次调 16px；已到最小宽度时继续 ← 则折叠，与拖拽一致。
	const handleResizeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
		event.preventDefault();
		if (event.key === "ArrowLeft" && sidebarWidth <= MIN_SIDEBAR_WIDTH) {
			onCollapse?.();
			return;
		}
		const delta = event.key === "ArrowRight" ? RESIZE_STEP : -RESIZE_STEP;
		setSidebarWidth(
			Math.min(
				MAX_SIDEBAR_WIDTH,
				Math.max(MIN_SIDEBAR_WIDTH, sidebarWidth + delta),
			),
		);
	};

	return {
		asideRef,
		settledCollapsed,
		sidebarWidth,
		resizing,
		startResize,
		handleResizeKeyDown,
	};
}
