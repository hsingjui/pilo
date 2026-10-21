import type { ReactNode } from "react";
import { X } from "lucide-react";

export const COMPOSER_ATTACHMENT_PREVIEW_CLASS_NAME =
	"inline-flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-s-md px-2 text-xs text-foreground transition-colors hover:bg-hover data-[state=open]:bg-hover motion-reduce:transition-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11 pointer-coarse:min-w-11";

export function ComposerAttachment({
	kind,
	children,
	removeLabel,
	disabled,
	onRemove,
}: {
	kind: "image" | "reference";
	children: ReactNode;
	removeLabel: string;
	disabled: boolean;
	onRemove: () => void;
}) {
	return (
		<span
			data-chat-composer-attachment-chip=""
			data-chat-composer-image={kind === "image" ? "" : undefined}
			data-chat-composer-reference={kind === "reference" ? "" : undefined}
			className="inline-flex h-[max(1.75rem,var(--pilo-composer-line-height))] min-w-0 max-w-[min(12rem,100%)] items-center rounded-md bg-muted/60 pointer-coarse:min-h-11"
		>
			{children}
			<button
				type="button"
				disabled={disabled}
				aria-label={removeLabel}
				className="inline-flex h-full w-6 shrink-0 items-center justify-center rounded-e-md text-muted-foreground transition-colors hover:bg-hover hover:text-foreground motion-reduce:transition-none focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 pointer-coarse:min-h-11 pointer-coarse:min-w-11"
				onClick={onRemove}
			>
				<X className="size-3" aria-hidden="true" />
			</button>
		</span>
	);
}
