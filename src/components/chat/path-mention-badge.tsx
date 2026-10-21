import { isTauri } from "@tauri-apps/api/core";
import { FileCode2, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useChatFileOpen } from "@/components/chat/chat-file-open-context";
import { COMPOSER_ATTACHMENT_PREVIEW_CLASS_NAME } from "@/components/chat/composer-attachment";
import {
	canPreviewFileMention,
	fileMentionName,
} from "@/lib/chat/chat-mentions";
import { Hint, Popover, PopoverContent, PopoverTrigger } from "@/ui";

/** Shared file/session surface with optional activation and a path-preview fallback. */
export function PathMentionBadge({
	title,
	path,
	description,
	icon: Icon,
	label,
	compact = false,
	onOpen,
}: {
	title: string;
	path: string;
	description?: string;
	icon: LucideIcon;
	label: string;
	compact?: boolean;
	onOpen?: () => void;
}) {
	const trigger = (
		<button
			type="button"
			aria-label={label}
			data-chat-search-reference={compact ? undefined : ""}
			onClick={onOpen}
			className={
				compact
					? COMPOSER_ATTACHMENT_PREVIEW_CLASS_NAME
					: "my-0.5 inline-flex min-w-0 max-w-[min(12rem,100%)] items-center gap-1.5 rounded-md border border-foreground/10 bg-background/40 px-2 py-1 text-xs align-middle focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:min-h-11"
			}
		>
			<Icon
				className="size-3.5 shrink-0 text-muted-foreground"
				strokeWidth={1.5}
				aria-hidden="true"
			/>
			<span className="min-w-0 truncate">{title}</span>
		</button>
	);
	if (onOpen) return <Hint label={path}>{trigger}</Hint>;

	return (
		<Popover>
			<Hint label={path}>
				<PopoverTrigger asChild>{trigger}</PopoverTrigger>
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
	const fileOpener = useChatFileOpen();
	const title = fileMentionName(path);
	const onOpen =
		isTauri() && canPreviewFileMention(path) && fileOpener?.canOpenFile(path)
			? () => fileOpener.openFile(path)
			: undefined;
	return (
		<PathMentionBadge
			title={title}
			path={path}
			icon={FileCode2}
			label={
				onOpen
					? t("chat.openFile", { path })
					: t("chat.fileMentionPath", { name: title })
			}
			compact={compact}
			onOpen={onOpen}
		/>
	);
}
