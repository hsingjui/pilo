import {
	Suspense,
	useContext,
	useEffect,
	useMemo,
	useRef,
	type CSSProperties,
} from "react";
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
	type WorkspaceLineRange,
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
				sourceLines
				className="mx-auto max-w-4xl p-4 font-sans sm:p-6"
			/>
		</ChatMarkdownImageScopeProvider>
	);
}

function ProjectPlainPreview({
	content,
	lineRange,
}: {
	content: string;
	lineRange?: WorkspaceLineRange;
}) {
	const selection = useMemo(() => {
		if (!lineRange) return null;
		let start = 0;
		let end = content.length;
		let startLine = 1;
		let endLine = 1;
		for (const newline of content.matchAll(/\r\n|\r|\n/g)) {
			if (endLine === lineRange.end) {
				end = newline.index;
				break;
			}
			endLine += 1;
			if (endLine <= lineRange.start) {
				start = newline.index + newline[0].length;
				startLine = endLine;
			}
		}
		return { start, end, startLine, endLine };
	}, [content, lineRange]);
	return (
		<pre className="min-h-full min-w-max whitespace-pre p-3 leading-relaxed">
			<code>
				{selection ? (
					<>
						{content.slice(0, selection.start)}
						<span
							className="project-source-lines"
							data-source-line-start={selection.startLine}
							data-source-line-end={selection.endLine}
						>
							{content.slice(selection.start, selection.end)}
						</span>
						{content.slice(selection.end)}
					</>
				) : (
					content
				)}
			</code>
		</pre>
	);
}

function ProjectFilePanel({
	project,
	file,
	active,
	lineRange,
	readImage,
	style,
}: {
	project: Project;
	file: WorkspaceFile;
	active: boolean;
	lineRange?: WorkspaceLineRange;
	readImage?: ChatProjectImageScope["readImage"];
	style: CSSProperties;
}) {
	const { t } = useTranslation();
	const panelRef = useRef<HTMLElement>(null);
	useEffect(() => {
		const panel = panelRef.current;
		if (!panel || !active || !lineRange) return;
		let frame: number | null = null;
		let scrollTarget: HTMLElement | null = null;
		const clear = () => {
			for (const node of panel.querySelectorAll("[data-source-line-highlight]"))
				node.removeAttribute("data-source-line-highlight");
		};
		const apply = () => {
			frame = null;
			const blocks = panel.querySelectorAll<HTMLElement>(
				"[data-source-line-start]",
			);
			const selected = new Set<HTMLElement>();
			let closest: HTMLElement | null = null;
			let distance = Number.POSITIVE_INFINITY;
			for (const block of blocks) {
				const start = Number(block.dataset.sourceLineStart);
				const end = Number(block.dataset.sourceLineEnd);
				if (start <= lineRange.end && end >= lineRange.start)
					selected.add(block);
				const gap = Math.max(start - lineRange.start, lineRange.start - end, 0);
				if (gap < distance) {
					closest = block;
					distance = gap;
				}
			}
			// Prefer specific paragraphs/cells over their enclosing list/quote/table.
			for (const block of selected) {
				for (
					let parent = block.parentElement;
					parent && parent !== panel;
					parent = parent.parentElement
				)
					selected.delete(parent);
			}
			if (!selected.size && closest) selected.add(closest);
			clear();
			for (const block of selected) block.dataset.sourceLineHighlight = "";
			const target = selected.values().next().value;
			if (!target || target === scrollTarget) return;
			scrollTarget = target;
			panel.scrollTo({
				top:
					panel.scrollTop +
					target.getBoundingClientRect().top -
					panel.getBoundingClientRect().top -
					panel.clientTop -
					panel.clientHeight / 4,
				behavior: "auto",
			});
		};
		const schedule = () => {
			if (frame === null) frame = requestAnimationFrame(apply);
		};
		// Suspense, syntax highlighting and rich Markdown can replace the target DOM.
		const observer = new MutationObserver(schedule);
		observer.observe(panel, { childList: true, subtree: true });
		schedule();
		return () => {
			observer.disconnect();
			if (frame !== null) cancelAnimationFrame(frame);
			clear();
		};
	}, [active, lineRange]);
	return (
		<section
			ref={panelRef}
			role="tabpanel"
			aria-label={file.path}
			tabIndex={0}
			inert={!active}
			className={cn(
				"project-file-highlight scrollbar-pro absolute inset-2 overflow-auto overscroll-contain rounded-lg border border-border bg-background text-foreground focus-visible:outline-2 focus-visible:outline-ring",
				!active && "invisible",
			)}
			style={style}
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
				<ProjectPlainPreview content={file.content} lineRange={lineRange} />
			)}
		</section>
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
					<ProjectFilePanel
						key={file.path}
						project={project}
						file={file}
						active={file.path === activePath}
						lineRange={
							activeTab.kind === "file" && file.path === activePath
								? activeTab.lineRange
								: undefined
						}
						readImage={readImage}
						style={{
							fontFamily: getMonospaceFontFamilyStack(codeFontFamily),
							fontSize: codeFontSize,
						}}
					/>
				))}
			</div>
		</ChatMarkdownLinkScope.Provider>
	);
}
