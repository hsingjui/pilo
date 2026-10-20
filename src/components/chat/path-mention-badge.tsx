import { FileCode2, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { fileMentionName } from "@/lib/chat/chat-mentions";
import { cn } from "@/lib/utils";
import { Hint, Popover, PopoverContent, PopoverTrigger } from "@/ui";

/** Shared file/session surface with a touch-accessible path preview. */
export function PathMentionBadge({
	title,
	path,
	description,
	icon: Icon,
	label,
	compact = false,
}: {
	title: string;
	path: string;
	description?: string;
	icon: LucideIcon;
	label: string;
	compact?: boolean;
}) {
	return (
		<Popover>
			<Hint label={path}>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label={label}
						data-chat-search-reference={compact ? undefined : ""}
						className={cn(
							"group/mention inline-flex min-w-0 max-w-[min(12rem,100%)] items-center gap-1.5 rounded-md border border-foreground/10 bg-background/40 px-2 py-1 text-xs align-middle focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11",
							compact
								? "h-(--pilo-composer-line-height) items-center border-0 bg-transparent p-0"
								: "my-0.5",
						)}
					>
						{/* Keep the chip compact inside the full-height touch target. */}
						<span
							className={
								compact
									? "inline-flex h-(--pilo-composer-line-height) min-w-0 max-w-full items-baseline gap-1.5 rounded-md bg-muted/60 px-2 transition-[background-color] duration-150 ease-(--ease) group-hover/mention:bg-hover group-data-[state=open]/mention:bg-hover"
									: "contents"
							}
						>
							<Icon
								className={cn(
									"size-3.5 shrink-0 text-muted-foreground",
									compact && "self-center",
								)}
								strokeWidth={1.5}
								aria-hidden="true"
							/>
							<span
								className={cn(
									"min-w-0 truncate",
									compact && "leading-(--pilo-composer-line-height)",
								)}
							>
								{title}
							</span>
						</span>
					</button>
				</PopoverTrigger>
			</Hint>
			<PopoverContent className="w-80 max-w-[calc(100vw-2rem)] p-3 text-xs">
				<p className="mb-1 break-words font-medium">{title}</p>
				{description ? (
					<p className="mb-1 break-words text-muted-foreground">
						{description}
					</p>
				) : null}
				<p className="select-text break-all font-mono">{path}</p>
			</PopoverContent>
		</Popover>
	);
}

export function FileMentionBadge({
	path,
	compact = false,
}: {
	path: string;
	compact?: boolean;
}) {
	const { t } = useTranslation();
	const title = fileMentionName(path);
	return (
		<PathMentionBadge
			title={title}
			path={path}
			icon={FileCode2}
			label={t("chat.fileMentionPath", { name: title })}
			compact={compact}
		/>
	);
}
