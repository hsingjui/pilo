import { useEffect } from "react";

/**
 * 地址栏收放只会让 visual viewport 缩几十像素，键盘通常占据屏幕 1/4 以上。
 * 用该阈值区分，避免滚动时地址栏伸缩被误判成键盘、导致根容器抖动。
 */
const KEYBOARD_SHRINK_RATIO = 0.25;

/**
 * iOS Safari 的软键盘不压缩布局视口（dvh 不含键盘，也不支持
 * interactive-widget=resizes-content），底部输入框会被键盘盖住。
 * 用 visualViewport 的实际高度兜底：键盘弹出时根容器收缩到键盘上方。
 * 捏合缩放时 scale !== 1，此时不跟随，避免应用在高倍缩放时被压扁。
 */
export function useRemoteKeyboardInset() {
	useEffect(() => {
		const viewport = window.visualViewport;
		if (!viewport) return;
		const root = document.documentElement;
		const update = () => {
			const keyboardOpen =
				viewport.scale === 1 &&
				window.innerHeight - viewport.height >
					window.innerHeight * KEYBOARD_SHRINK_RATIO;
			if (keyboardOpen) {
				root.style.setProperty(
					"--remote-viewport-height",
					`${viewport.height}px`,
				);
				return;
			}
			root.style.removeProperty("--remote-viewport-height");
		};
		update();
		viewport.addEventListener("resize", update);
		viewport.addEventListener("scroll", update);
		return () => {
			viewport.removeEventListener("resize", update);
			viewport.removeEventListener("scroll", update);
			root.style.removeProperty("--remote-viewport-height");
		};
	}, []);
}
