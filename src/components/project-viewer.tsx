import { Suspense, useContext, useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { ProjectWorkspaceContext } from "@/components/app/project-workspace-context";
import { ChatMarkdown } from "@/components/chat/chat-markdown";
import { ChatMarkdownLinkScope } from "@/components/chat/chat-markdown-link";
import { ChatMarkdownImageScopeProvider } from "@/components/chat/chat-markdown-image";
import { projectMarkdownImageScope } from "@/lib/chat/chat-markdown-images";
import type { ChatProjectImageScope } from "@/lib/chat/chat-image-media";
import { highlightProjectFile } from "@/lib/code-highlighter";
import { fileLinkPreviewKind } from "@/lib/chat/chat-markdown-links";
import { getMonospaceFontFamilyStack } from "@/lib/font-settings";
import { usePreferences } from "@/lib/preferences-provider";
import type { Project } from "@/lib/api/projects";
import {
	EMPTY_PROJECT_WORKSPACE,
	type WorkspaceFile,
} from "@/lib/project-workspace";
import { cn } from "@/lib/utils";

import "./project-viewer.css";

function ProjectMarkdownPreview({
	project,
	file,
	readImage,
}: {
	project: Project;
	file: WorkspaceFile;
	readImage?: ChatProjectImageScope["readImage"];
}) {
	const scope = useMemo(() => {
		const imageScope = projectMarkdownImageScope(
			{ id: project.id, path: project.path },
			file.path,
		);
		return imageScope ? { ...imageScope, readImage } : null;
	}, [project.id, project.path, file.path, readImage]);
	return (
		<ChatMarkdownImageScopeProvider scope={scope}>
			<ChatMarkdown
				text={file.content}
				className="mx-auto max-w-4xl p-4 font-sans sm:p-6"
			/>
		</ChatMarkdownImageScopeProvider>
	);
}

/** Content only: session and file navigation share SessionHeader's tab strip. */
export function ProjectViewer({
	project,
	headerOverlay = false,
	readImage,
}: {
	project: Project;
	headerOverlay?: boolean;
	readImage?: ChatProjectImageScope["readImage"];
}) {
	const { t } = useTranslation();
	const { codeFontFamily, codeFontSize } = usePreferences();
	const workspace = useContext(ProjectWorkspaceContext);
	const { files, activeTab } =
		workspace?.state.get(project.id) ?? EMPTY_PROJECT_WORKSPACE;
	const activePath = activeTab.kind === "file" ? activeTab.path : null;
	const activeFile = files.find((file) => file.path === activePath);
	const highlightFile = workspace?.highlightFile;
	useEffect(() => {
		if (
			!activeFile ||
			activeFile.html !== undefined ||
			fileLinkPreviewKind(activeFile.path) === "markdown" ||
			!highlightFile
		)
			return;
		let cancelled = false;
		void highlightProjectFile(activeFile.path, activeFile.content)
			.then((html) => {
				if (!cancelled) highlightFile(project.id, activeFile, html);
			})
			.catch(() => {
				if (!cancelled) highlightFile(project.id, activeFile, null);
			});
		return () => {
			cancelled = true;
		};
	}, [activeFile, highlightFile, project.id]);
	return (
		<ChatMarkdownLinkScope.Provider value={project}>
			<div
				className={cn(
					"absolute inset-0 z-30 bg-background",
					headerOverlay && "top-11",
					activePath === null && "pointer-events-none invisible",
				)}
				inert={activePath === null}
			>
				{files.map((file) => (
					<section
						key={file.path}
						role="tabpanel"
						aria-label={file.path}
						tabIndex={0}
						inert={file.path !== activePath}
						className={cn(
							"project-file-highlight scrollbar-pro absolute inset-2 overflow-auto overscroll-contain rounded-lg border border-border bg-background text-foreground focus-visible:outline-2 focus-visible:outline-ring",
							file.path !== activePath && "invisible",
						)}
						style={{
							fontFamily: getMonospaceFontFamilyStack(codeFontFamily),
							fontSize: codeFontSize,
						}}
					>
						{fileLinkPreviewKind(file.path) === "markdown" ? (
							<Suspense fallback={<p className="p-4">{t("common.loading")}</p>}>
								<ProjectMarkdownPreview
									project={project}
									file={file}
									readImage={readImage}
								/>
							</Suspense>
						) : file.html ? (
							<div dangerouslySetInnerHTML={{ __html: file.html }} />
						) : (
							<pre className="min-h-full min-w-max whitespace-pre p-3 leading-relaxed">
								<code>{file.content}</code>
							</pre>
						)}
					</section>
				))}
			</div>
		</ChatMarkdownLinkScope.Provider>
	);
}
