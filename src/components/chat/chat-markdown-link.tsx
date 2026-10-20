import { ArrowUpRight, FileCode2 } from "lucide-react";
import {
	createContext,
	useContext,
	useState,
	type ComponentPropsWithoutRef,
} from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import type { Project } from "@/lib/api/projects";
import { ProjectWorkspaceContext } from "@/components/app/project-workspace-context";
import { openFileLink } from "@/lib/api/file-links";
import { resolveMarkdownFileUrl } from "@/lib/chat/chat-markdown-links";
import { workspaceFileKey } from "@/lib/project-workspace";
import { cn } from "@/lib/utils";

export const ChatMarkdownLinkScope = createContext<Pick<
	Project,
	"id" | "connection"
> | null>(null);

type MarkdownLinkProps = ComponentPropsWithoutRef<"a"> & {
	node?: unknown;
	"data-pilo-file-url"?: string;
	"data-pilo-file-layout"?: "standalone";
};

export function MarkdownLink({
	children,
	rel,
	node: _node,
	"data-pilo-file-url": fileUrl,
	"data-pilo-file-layout": fileLayout,
	...props
}: MarkdownLinkProps) {
	const { t } = useTranslation();
	const project = useContext(ChatMarkdownLinkScope);
	const workspace = useContext(ProjectWorkspaceContext);
	const [opening, setOpening] = useState(false);
	if (fileUrl !== undefined) {
		const url = resolveMarkdownFileUrl(fileUrl);
		const standalone = fileLayout === "standalone";
		return (
			<button
				type="button"
				title={fileUrl}
				disabled={opening}
				aria-busy={opening}
				data-chat-search-reference=""
				className={cn(
					"min-w-0 max-w-full cursor-pointer touch-manipulation text-left text-foreground transition-colors disabled:cursor-wait disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [@media(pointer:coarse)]:min-h-11",
					standalone
						? "mt-2 flex min-h-8 w-fit items-center gap-2 rounded-md border border-border/70 bg-muted/40 px-3 py-1.5 text-sm font-medium no-underline first:mt-0 hover:bg-hover [&+br]:hidden"
						: "inline-block min-h-6 rounded-sm p-0 align-baseline [font:inherit] underline decoration-muted-foreground/40 underline-offset-2 hover:decoration-muted-foreground",
				)}
				onClick={() => {
					if (!url) {
						toast.error(t("chat.fileLinkInvalid"));
						return;
					}
					const path = decodeURIComponent(new URL(url).pathname).replace(
						/^\/([a-z]:\/)/i,
						"$1",
					);
					const existing =
						project &&
						workspace?.state
							.get(project.id)
							?.files.find(
								(file) =>
									workspaceFileKey(file.path) === workspaceFileKey(path),
							);
					if (existing && project && workspace) {
						workspace.selectFile(project.id, existing.path);
						return;
					}
					setOpening(true);
					void openFileLink(project, url)
						.then((file) => {
							if (!file || !project) return;
							if (!workspace) throw new Error(t("file.workspaceUnavailable"));
							workspace.openFile(project.id, file);
						})
						.catch((error: unknown) => {
							toast.error(t("chat.fileLinkOpenFailed"), {
								description:
									error instanceof Error
										? error.message
										: t("chat.fileLinkCheckPath"),
							});
						})
						.finally(() => setOpening(false));
				}}
			>
				{standalone && (
					<FileCode2
						aria-hidden="true"
						className="size-4 shrink-0 text-muted-foreground"
					/>
				)}
				<span
					className={
						standalone ? "min-w-0 truncate" : "[overflow-wrap:anywhere]"
					}
				>
					{children}
				</span>
				{standalone && (
					<ArrowUpRight
						aria-hidden="true"
						className="size-3.5 shrink-0 text-muted-foreground"
					/>
				)}
			</button>
		);
	}
	return (
		<a
			{...props}
			target="_blank"
			rel={`${rel ?? ""} noopener noreferrer`.trim()}
		>
			{children}
		</a>
	);
}
