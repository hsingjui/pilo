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
		let focusFrame: number | undefined;
		const update = () => {
			const focused = document.activeElement;
			// File pickers can leave stale viewport geometry after dismissing the keyboard.
			const editing =
				focused instanceof HTMLElement &&
				focused.matches(
					'textarea, input:not([type="file"]), [contenteditable="true"]',
				);
			const keyboardOpen =
				editing &&
				viewport.scale === 1 &&
				window.innerHeight - viewport.height >
					window.innerHeight * KEYBOARD_SHRINK_RATIO;
			if (keyboardOpen) {
				root.style.setProperty("--remote-composer-bottom-padding", "0.5rem");
				root.style.setProperty(
					"--remote-viewport-height",
					`${viewport.height}px`,
				);
				root.style.setProperty(
					"--remote-keyboard-bottom",
					`${Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)}px`,
				);
				return;
			}
			root.style.removeProperty("--remote-composer-bottom-padding");
			root.style.removeProperty("--remote-viewport-height");
			root.style.removeProperty("--remote-keyboard-bottom");
		};
		const handleFocusChange = () => {
			if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
			// Wait until focusout has updated document.activeElement.
			focusFrame = window.requestAnimationFrame(update);
		};
		update();
		viewport.addEventListener("resize", update);
		viewport.addEventListener("scroll", update);
		window.addEventListener("resize", update);
		window.addEventListener("focus", update);
		document.addEventListener("visibilitychange", update);
		document.addEventListener("focusin", handleFocusChange);
		document.addEventListener("focusout", handleFocusChange);
		return () => {
			if (focusFrame !== undefined) window.cancelAnimationFrame(focusFrame);
			viewport.removeEventListener("resize", update);
			viewport.removeEventListener("scroll", update);
			window.removeEventListener("resize", update);
			window.removeEventListener("focus", update);
			document.removeEventListener("visibilitychange", update);
			document.removeEventListener("focusin", handleFocusChange);
			document.removeEventListener("focusout", handleFocusChange);
			root.style.removeProperty("--remote-composer-bottom-padding");
			root.style.removeProperty("--remote-viewport-height");
			root.style.removeProperty("--remote-keyboard-bottom");
		};
	}, []);
}
