import { useEffect, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { openChatImageLightbox } from "@/components/chat/chat-image-viewer";
import { useChatProjectImageScope } from "@/components/chat/chat-markdown-image";
import { loadChatProjectImageUrl } from "@/lib/chat/chat-image-media";
import { resolveMarkdownImageSource } from "@/lib/chat/chat-markdown-images";
import { workspaceFileKey } from "@/lib/project-workspace";

/** Desktop text files use workspace tabs; project images use the shared lightbox. */
type ChatFileOpenHandler = (path: string) => void;
type ChatFileOpener = {
	openFile: ChatFileOpenHandler;
	canOpenFile: (path: string) => boolean;
};

let opener: ChatFileOpener | null = null;
const listeners = new Set<() => void>();

function emit() {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function useChatFileOpener(
	onOpenFile: ChatFileOpenHandler | undefined,
	canOpenFile: ChatFileOpener["canOpenFile"],
) {
	useEffect(() => {
		if (!onOpenFile) return;
		const registeredOpener = { openFile: onOpenFile, canOpenFile };
		opener = registeredOpener;
		emit();
		return () => {
			if (opener === registeredOpener) {
				opener = null;
				emit();
			}
		};
	}, [onOpenFile, canOpenFile]);
}

/** Images use the conversation's project and transport, including on WebUI. */
export function useChatFileOpen(): ChatFileOpener | null {
	const { t } = useTranslation();
	const scope = useChatProjectImageScope();
	const fileOpener = useSyncExternalStore(
		subscribe,
		() => opener,
		() => opener,
	);
	if (!scope?.projectPath) return fileOpener;

	const root = workspaceFileKey(scope.projectPath).replace(/\/+$/, "");
	const imageSource = (candidate: string) => {
		const path = workspaceFileKey(candidate.trim());
		const relative = path.startsWith(`${root}/`)
			? path.slice(root.length + 1)
			: path;
		// Tool paths are literal filesystem names, not URL-encoded Markdown sources.
		return resolveMarkdownImageSource(encodeURIComponent(relative));
	};
	return {
		canOpenFile: (path) =>
			imageSource(path).type === "project" ||
			Boolean(fileOpener?.canOpenFile(path)),
		openFile: (path) => {
			const source = imageSource(path);
			if (source.type !== "project") {
				fileOpener?.openFile(path);
				return;
			}
			void loadChatProjectImageUrl(source.path, source.mimeType, scope)
				.then((url) => {
					openChatImageLightbox({
						url,
						name: source.path.split("/").pop() || source.path,
					});
				})
				.catch((error: unknown) => {
					toast.error(t("chat.loadImageFailed"), {
						description: error instanceof Error ? error.message : String(error),
					});
				});
		},
	};
}
