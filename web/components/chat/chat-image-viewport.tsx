import { useTranslation } from "react-i18next";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Minus, Plus } from "lucide-react";

import { usePanZoomViewport } from "@/lib/use-pan-zoom-viewport";
import { cn } from "@/lib/utils";

const CONTROL_CLASS =
	"inline-flex min-w-11 min-h-11 items-center justify-center rounded-md px-3 text-white/80 hover:bg-white/15 hover:text-white disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-ring";

export function ChatImageViewport({
	url,
	name,
	onClose,
}: {
	url: string;
	name: string;
	onClose: () => void;
}) {
	const { t } = useTranslation();
	const { viewportProps, imageProps, scale, maxScale, zoom, reset } =
		usePanZoomViewport({ onBackgroundClick: onClose });

	const image = (
		<img
			{...imageProps}
			src={url}
			alt={name}
			draggable={false}
			decoding="async"
			className={cn(
				"max-h-full max-w-full shrink-0 select-none rounded-md object-contain shadow-2xl",
				scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
			)}
		/>
	);

	return (
		<>
			{/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex -- The image region is focusable for keyboard zoom/pan; Escape closes via Dialog. */}
			<section
				{...viewportProps}
				aria-label={name}
				tabIndex={0}
				className="flex min-h-0 flex-1 touch-none select-none items-center justify-center overflow-hidden rounded-md focus-visible:outline-2 focus-visible:outline-ring [-webkit-touch-callout:none]"
			>
				<DialogPrimitive.Description asChild>
					{image}
				</DialogPrimitive.Description>
			</section>
			{/* oxlint-enable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex */}
			<div className="flex shrink-0 items-center justify-center gap-1 pt-2">
				<button
					type="button"
					className={CONTROL_CLASS}
					aria-label={t("chat.zoomOutImage")}
					disabled={scale <= 1}
					onClick={() => zoom(1 / 1.5)}
				>
					<Minus className="size-4" aria-hidden="true" />
				</button>
				<button
					type="button"
					className={CONTROL_CLASS}
					aria-label={t("chat.resetImageZoom", {
						percent: Math.round(scale * 100),
					})}
					onClick={reset}
				>
					<span className="text-xs tabular-nums">
						{Math.round(scale * 100)}%
					</span>
				</button>
				<button
					type="button"
					className={CONTROL_CLASS}
					aria-label={t("chat.zoomInImage")}
					disabled={scale >= maxScale}
					onClick={() => zoom(1.5)}
				>
					<Plus className="size-4" aria-hidden="true" />
				</button>
			</div>
		</>
	);
}
