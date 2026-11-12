import {
	useCallback,
	useEffect,
	useRef,
	useState,
	type ComponentPropsWithRef,
} from "react";

const MAX_SCALE = 5;
type Point = { x: number; y: number };
type ImageTransform = Point & { scale: number };

export function usePanZoomViewport({
	allowNativeZoom = false,
	onBackgroundClick,
}: {
	allowNativeZoom?: boolean;
	onBackgroundClick?: () => void;
}) {
	const viewportRef = useRef<HTMLElement>(null);
	const imageRef = useRef<HTMLImageElement>(null);
	const [transform, setTransform] = useState<ImageTransform>({
		x: 0,
		y: 0,
		scale: 1,
	});
	const transformRef = useRef(transform);
	const pointersRef = useRef(new Map<number, Point>());
	const gestureRef = useRef({ x: 0, y: 0, moved: false, background: false });
	const [maxScale, setMaxScale] = useState(MAX_SCALE);

	const getMaxScale = useCallback(() => {
		const image = imageRef.current;
		return allowNativeZoom && image?.offsetWidth
			? Math.max(MAX_SCALE, image.naturalWidth / image.offsetWidth)
			: MAX_SCALE;
	}, [allowNativeZoom]);

	const applyTransform = useCallback(
		(next: ImageTransform) => {
			const viewport = viewportRef.current;
			const image = imageRef.current;
			if (!viewport || !image) return;
			const limit = getMaxScale();
			setMaxScale(limit);
			const scale = Math.max(1, Math.min(limit, next.scale));
			const maxX = Math.max(
				0,
				(image.offsetWidth * scale - viewport.clientWidth) / 2,
			);
			const maxY = Math.max(
				0,
				(image.offsetHeight * scale - viewport.clientHeight) / 2,
			);
			const x = Math.max(-maxX, Math.min(maxX, next.x));
			const y = Math.max(-maxY, Math.min(maxY, next.y));
			const current = transformRef.current;
			if (scale === current.scale && x === current.x && y === current.y) return;
			const value = { scale, x, y };
			transformRef.current = value;
			setTransform(value);
		},
		[getMaxScale],
	);

	const zoom = useCallback(
		(factor: number, anchor?: Point) => {
			const current = transformRef.current;
			const scale = Math.max(
				1,
				Math.min(getMaxScale(), current.scale * factor),
			);
			const rect = viewportRef.current?.getBoundingClientRect();
			const x = anchor && rect ? anchor.x - rect.left - rect.width / 2 : 0;
			const y = anchor && rect ? anchor.y - rect.top - rect.height / 2 : 0;
			const ratio = scale / current.scale;
			applyTransform({
				scale,
				x: x - (x - current.x) * ratio,
				y: y - (y - current.y) * ratio,
			});
		},
		[applyTransform, getMaxScale],
	);

	useEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport) return;
		const handleWheel = (event: WheelEvent) => {
			const current = transformRef.current;
			if (!event.ctrlKey && current.scale <= 1) return;
			event.preventDefault();
			const unit =
				event.deltaMode === WheelEvent.DOM_DELTA_LINE
					? 16
					: event.deltaMode === WheelEvent.DOM_DELTA_PAGE
						? viewport.clientHeight
						: 1;
			if (event.ctrlKey) {
				zoom(Math.exp(-event.deltaY * unit * 0.002), {
					x: event.clientX,
					y: event.clientY,
				});
			} else {
				applyTransform({
					...current,
					x:
						current.x -
						(event.deltaX || (event.shiftKey ? event.deltaY : 0)) * unit,
					y: current.y - (event.shiftKey ? 0 : event.deltaY) * unit,
				});
			}
		};
		// React wheel listeners are passive and cannot prevent page zoom.
		viewport.addEventListener("wheel", handleWheel, { passive: false });
		return () => viewport.removeEventListener("wheel", handleWheel);
	}, [applyTransform, zoom]);

	useEffect(() => {
		const viewport = viewportRef.current;
		const image = imageRef.current;
		if (!viewport || !image) return;
		const observer = new ResizeObserver(() =>
			applyTransform(transformRef.current),
		);
		observer.observe(viewport);
		observer.observe(image);
		return () => observer.disconnect();
	}, [applyTransform]);

	const reset = () => applyTransform({ x: 0, y: 0, scale: 1 });
	const viewportProps = {
		ref: viewportRef,
		onKeyDown: (event) => {
			if (event.ctrlKey || event.metaKey || event.altKey) return;
			const current = transformRef.current;
			switch (event.key) {
				case "+":
				case "=":
					zoom(1.5);
					break;
				case "-":
					zoom(1 / 1.5);
					break;
				case "0":
					reset();
					break;
				case "ArrowLeft":
					applyTransform({ ...current, x: current.x + 50 });
					break;
				case "ArrowRight":
					applyTransform({ ...current, x: current.x - 50 });
					break;
				case "ArrowUp":
					applyTransform({ ...current, y: current.y + 50 });
					break;
				case "ArrowDown":
					applyTransform({ ...current, y: current.y - 50 });
					break;
				default:
					return;
			}
			event.preventDefault();
		},
		onDoubleClick: (event) => {
			// Pointer capture retargets clicks to the viewport; use the gesture origin.
			if (gestureRef.current.background || gestureRef.current.moved) return;
			event.preventDefault();
			if (transformRef.current.scale > 1) {
				reset();
			} else {
				zoom(2, { x: event.clientX, y: event.clientY });
			}
		},
		onPointerDown: (event) => {
			if (event.button !== 0 || pointersRef.current.size >= 2) return;
			if (pointersRef.current.size === 0) {
				gestureRef.current = {
					x: event.clientX,
					y: event.clientY,
					moved: false,
					background: event.target === event.currentTarget,
				};
			} else {
				gestureRef.current.moved = true;
			}
			pointersRef.current.set(event.pointerId, {
				x: event.clientX,
				y: event.clientY,
			});
			event.currentTarget.setPointerCapture(event.pointerId);
		},
		onPointerMove: (event) => {
			const pointers = pointersRef.current;
			const previous = pointers.get(event.pointerId);
			if (!previous) return;
			const before = [...pointers.values()];
			const point = { x: event.clientX, y: event.clientY };
			pointers.set(event.pointerId, point);
			const gesture = gestureRef.current;
			if (Math.hypot(point.x - gesture.x, point.y - gesture.y) > 4)
				gesture.moved = true;
			const current = transformRef.current;
			const [first, second] = [...pointers.values()];
			if (second) {
				const [oldFirst, oldSecond] = before;
				const distance = Math.hypot(
					oldFirst.x - oldSecond.x,
					oldFirst.y - oldSecond.y,
				);
				if (distance === 0) return;
				const scale = Math.max(
					1,
					Math.min(
						getMaxScale(),
						current.scale *
							(Math.hypot(first.x - second.x, first.y - second.y) / distance),
					),
				);
				const rect = event.currentTarget.getBoundingClientRect();
				const oldX =
					(oldFirst.x + oldSecond.x) / 2 - rect.left - rect.width / 2;
				const oldY =
					(oldFirst.y + oldSecond.y) / 2 - rect.top - rect.height / 2;
				const x = (first.x + second.x) / 2 - rect.left - rect.width / 2;
				const y = (first.y + second.y) / 2 - rect.top - rect.height / 2;
				applyTransform({
					scale,
					x: x - (oldX - current.x) * (scale / current.scale),
					y: y - (oldY - current.y) * (scale / current.scale),
				});
			} else if (current.scale > 1) {
				applyTransform({
					...current,
					x: current.x + point.x - previous.x,
					y: current.y + point.y - previous.y,
				});
			}
		},
		onPointerUp: (event) => pointersRef.current.delete(event.pointerId),
		onPointerCancel: (event) => {
			pointersRef.current.delete(event.pointerId);
			gestureRef.current.moved = true;
		},
		onLostPointerCapture: (event) =>
			pointersRef.current.delete(event.pointerId),
		onClick: (event) => {
			// Pointer capture retargets clicks; only an unmoved background tap closes.
			if (
				!gestureRef.current.moved &&
				gestureRef.current.background &&
				event.target === event.currentTarget
			)
				onBackgroundClick?.();
		},
	} satisfies ComponentPropsWithRef<"section">;

	return {
		viewportProps,
		imageProps: {
			ref: imageRef,
			style: {
				transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
			},
		},
		scale: transform.scale,
		maxScale,
		zoom,
		reset,
	};
}
