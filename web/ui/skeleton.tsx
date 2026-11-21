import { cn } from "@/lib/utils";

// 统一骨架块：主题色 `--skeleton-line(-strong)` 打底，每块自身 shimmer，
// reduced-motion 下停止扫光（见 index.css 的 `.pilo-skeleton-bone`）。
// 骨架块只做装饰，可访问的加载状态由外层的 `<output>` 文案提供。
function Skeleton({
	className,
	strong = false,
	...props
}: React.HTMLAttributes<HTMLDivElement> & { strong?: boolean }) {
	return (
		<div
			aria-hidden="true"
			className={cn(
				"pilo-skeleton-bone rounded-md",
				strong ? "pilo-skeleton-strong" : "pilo-skeleton-line",
				className,
			)}
			{...props}
		/>
	);
}

export { Skeleton };
