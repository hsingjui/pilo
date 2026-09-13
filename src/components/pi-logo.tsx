import { cn } from "@/lib/utils";

/** Pi 的 mark，路径取自 https://pi.dev/logo-auto.svg。 */
export function PiLogo({ className }: { className?: string }) {
	return (
		<svg
			viewBox="0 0 800 800"
			aria-hidden="true"
			className={cn("size-4 shrink-0", className)}
		>
			<path
				className="fill-current"
				fillRule="evenodd"
				d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
			/>
			<path className="fill-current" d="M517.36 400H634.72V634.72H517.36Z" />
		</svg>
	);
}
