import { useLayoutEffect, useRef, useState, type RefObject } from "react";

// 输入区不在滚动容器内，需要补上与滚动条 gutter 等宽的内边距才能和消息列左右对齐。
// 固定值在不同平台（overlay / thin / DPI 缩放）下并不一致，所以实测。
export function useScrollbarGutterWidth(
	ref: RefObject<HTMLElement | null>,
	enabled = true,
): number {
	const [gutterWidth, setGutterWidth] = useState(0);
	const bindingRef = useRef<{
		viewport: HTMLElement;
		disconnect: () => void;
	} | null>(null);
	useLayoutEffect(
		() => () => {
			bindingRef.current?.disconnect();
			bindingRef.current = null;
		},
		[],
	);

	// 会话切换可能替换 ref 指向的节点；普通提交不读布局，也不重建观察器。
	useLayoutEffect(() => {
		const viewport = enabled ? ref.current : null;
		if (viewport === (bindingRef.current?.viewport ?? null)) return;
		bindingRef.current?.disconnect();
		bindingRef.current = null;
		if (!viewport) return;
		let frame: number | null = null;
		const measure = () => {
			frame = null;
			const nextWidth = viewport.offsetWidth - viewport.clientWidth;
			setGutterWidth((currentWidth) =>
				currentWidth === nextWidth ? currentWidth : nextWidth,
			);
		};
		const scheduleMeasure = () => {
			if (frame !== null) return;
			frame = requestAnimationFrame(measure);
		};
		measure();
		const observer = new ResizeObserver(scheduleMeasure);
		observer.observe(viewport);
		bindingRef.current = {
			viewport,
			disconnect: () => {
				observer.disconnect();
				if (frame !== null) cancelAnimationFrame(frame);
			},
		};
	});
	return gutterWidth;
}
