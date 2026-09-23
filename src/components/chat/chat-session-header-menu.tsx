import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Copy,
	ExternalLink,
	MoreHorizontal,
	Pencil,
	Search,
} from "lucide-react";
import { toast } from "sonner";

import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	Input,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";
import type { ChatSession } from "./chat-page-utils";

const menuItemIconClassName = "size-3.5 shrink-0 text-muted-foreground";

function copyText(text: string) {
	return navigator.clipboard.writeText(text);
}

export function SessionHeaderMenu({
	session,
	onRenameSession,
	onFindInSession,
	onOpenInNewWindow,
}: {
	session: ChatSession;
	onRenameSession?: (title: string) => void;
	onFindInSession?: () => void;
	onOpenInNewWindow?: () => void;
}) {
	const { t } = useTranslation();
	const [renameOpen, setRenameOpen] = useState(false);
	const [renameValue, setRenameValue] = useState(session.title);
	const renameInputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (renameOpen) renameInputRef.current?.focus();
	}, [renameOpen]);

	const canRename = Boolean(onRenameSession && session.sessionPath);
	const canOpenInNewWindow = Boolean(onOpenInNewWindow && session.sessionPath);

	function handleCopy(text: string) {
		void copyText(text)
			.then(() => toast.success(t("chat.copied")))
			.catch(() => toast.error(t("chat.copyFailed")));
	}

	function submitRename() {
		const title = renameValue.trim();
		if (title && title !== session.title) onRenameSession?.(title);
		setRenameOpen(false);
	}

	return (
		<>
			<DropdownMenu>
				<Tooltip>
					<TooltipTrigger asChild>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon"
								className="size-7"
								aria-label={t("chat.sessionMenu")}
							>
								<MoreHorizontal className="size-4" />
							</Button>
						</DropdownMenuTrigger>
					</TooltipTrigger>
					<TooltipContent>{t("chat.sessionMenu")}</TooltipContent>
				</Tooltip>
				<DropdownMenuContent
					align="end"
					className="w-72"
					onCloseAutoFocus={(event) => event.preventDefault()}
				>
					<DropdownMenuItem
						className="gap-2"
						onSelect={() => handleCopy(session.id)}
					>
						<Copy className={menuItemIconClassName} />
						<span className="shrink-0 text-muted-foreground">
							{t("chat.sessionId")}
						</span>
						<span className="min-w-0 flex-1 truncate text-end font-mono text-xs">
							{session.id}
						</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						className="gap-2"
						disabled={!session.sessionPath}
						onSelect={() => {
							if (session.sessionPath) handleCopy(session.sessionPath);
						}}
					>
						<Copy className={menuItemIconClassName} />
						<span className="shrink-0 text-muted-foreground">
							{t("chat.sessionFilePath")}
						</span>
						<span className="min-w-0 flex-1 truncate text-end font-mono text-xs">
							{session.sessionPath ?? t("chat.sessionPathUnavailable")}
						</span>
					</DropdownMenuItem>
					{onFindInSession || canRename || canOpenInNewWindow ? (
						<DropdownMenuSeparator />
					) : null}
					{onFindInSession ? (
						<DropdownMenuItem
							className="gap-2"
							onSelect={() => onFindInSession()}
						>
							<Search className={menuItemIconClassName} />
							{t("chat.findInSession")}
						</DropdownMenuItem>
					) : null}
					{canRename ? (
						<DropdownMenuItem
							className="gap-2"
							onSelect={() => {
								setRenameValue(session.title);
								setRenameOpen(true);
							}}
						>
							<Pencil className={menuItemIconClassName} />
							{t("chat.renameSession")}
						</DropdownMenuItem>
					) : null}
					{canOpenInNewWindow ? (
						<DropdownMenuItem
							className="gap-2"
							onSelect={() => onOpenInNewWindow?.()}
						>
							<ExternalLink className={menuItemIconClassName} />
							{t("chat.openInNewWindow")}
						</DropdownMenuItem>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
			<Dialog open={renameOpen} onOpenChange={setRenameOpen}>
				<DialogContent className="max-w-md gap-4">
					<DialogHeader>
						<DialogTitle>{t("chat.renameDialogTitle")}</DialogTitle>
						<DialogDescription>
							{t("chat.renameDialogDescription")}
						</DialogDescription>
					</DialogHeader>
					<Input
						ref={renameInputRef}
						value={renameValue}
						aria-label={t("chat.renameDialogTitle")}
						placeholder={t("navigation.renamePlaceholder")}
						onChange={(event) => setRenameValue(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								submitRename();
							}
						}}
					/>
					<DialogFooter>
						<Button variant="ghost" onClick={() => setRenameOpen(false)}>
							{t("chat.renameDialogCancel")}
						</Button>
						<Button
							disabled={
								renameValue.trim().length === 0 ||
								renameValue.trim() === session.title
							}
							onClick={submitRename}
						>
							{t("chat.renameDialogConfirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
