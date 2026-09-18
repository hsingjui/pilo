import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileCode, MessageSquare, X } from "lucide-react";

import { TRAFFIC_LIGHT_GUTTER } from "@/components/title-bar";
import { userErrorMessage } from "@/lib/app-error";
import { highlightProjectFile } from "@/lib/code-highlighter";
import { readProjectFile } from "@/lib/files";
import { getMonospaceFontFamilyStack } from "@/lib/font-settings";
import { usePreferences } from "@/lib/preferences-provider";
import type { Project } from "@/lib/projects";
import { cn } from "@/lib/utils";
import { Button, EmptyState } from "@/ui";

import "./project-viewer.css";

export type ViewerOpenRequest = {
	id: number;
	projectId: string;
	path: string;
};

type ViewerTab = {
	path: string;
	content: string;
	loading: boolean;
	error?: string;
};

const MAX_VIEWER_BYTES = 5 * 1024 * 1024;

function decodeFile(data: Uint8Array) {
	if (data.byteLength > MAX_VIEWER_BYTES) {
		throw new Error(
			`文件超过 ${MAX_VIEWER_BYTES / 1024 / 1024} MB，暂不在查看器中打开。`,
		);
	}
	if (data.subarray(0, Math.min(data.length, 8192)).includes(0)) {
		throw new Error("该文件看起来是二进制文件，无法作为文本查看。");
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(data);
}

function fileName(path: string) {
	return path.split("/").pop() || path;
}

export function ProjectViewer({
	project,
	request,
	visible,
	onClose,
	reserveTrafficLights = false,
}: {
	project: Project;
	request?: ViewerOpenRequest;
	visible: boolean;
	onClose: () => void;
	/** macOS 侧边栏折叠时红绿灯覆盖主区左上角，顶部需要避让。 */
	reserveTrafficLights?: boolean;
}) {
	const { codeFontFamily, codeCustomFontFamily, codeFontSize } =
		usePreferences();
	const [tabs, setTabs] = useState<ViewerTab[]>([]);
	const [activePath, setActivePath] = useState<string | null>(null);
	const [highlighted, setHighlighted] = useState<{
		path: string;
		content: string;
		html: string;
	} | null>(null);
	const openedPathsRef = useRef(new Set<string>());
	const activeTab = useMemo(
		() => tabs.find((tab) => tab.path === activePath) ?? null,
		[activePath, tabs],
	);

	useEffect(() => {
		if (!request || request.projectId !== project.id) return;
		const path = request.path;
		const timer = window.setTimeout(() => {
			const alreadyOpen = openedPathsRef.current.has(path);
			setActivePath(path);
			if (alreadyOpen) return;
			openedPathsRef.current.add(path);
			setTabs((current) => [...current, { path, content: "", loading: true }]);
			void readProjectFile(project.id, path)
				.then((data) => decodeFile(data))
				.then((content) => {
					setTabs((current) =>
						current.map((tab) =>
							tab.path === path
								? { ...tab, content, loading: false, error: undefined }
								: tab,
						),
					);
				})
				.catch((error) => {
					setTabs((current) =>
						current.map((tab) =>
							tab.path === path
								? { ...tab, loading: false, error: userErrorMessage(error) }
								: tab,
						),
					);
				});
		}, 0);
		return () => window.clearTimeout(timer);
	}, [request, project.id]);

	useEffect(() => {
		let cancelled = false;
		if (!activeTab || activeTab.loading || activeTab.error) return;
		void highlightProjectFile(activeTab.path, activeTab.content)
			.then((html) => {
				if (!cancelled && html) {
					setHighlighted({
						path: activeTab.path,
						content: activeTab.content,
						html,
					});
				}
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [activeTab]);

	const highlightedHtml =
		activeTab &&
		highlighted?.path === activeTab.path &&
		highlighted.content === activeTab.content
			? highlighted.html
			: null;

	const closeTab = useCallback(
		(path: string) => {
			const index = tabs.findIndex((candidate) => candidate.path === path);
			const next = tabs.filter((candidate) => candidate.path !== path);
			openedPathsRef.current.delete(path);
			setTabs(next);
			if (activePath === path) {
				setActivePath(next[Math.min(index, next.length - 1)]?.path ?? null);
			}
		},
		[activePath, tabs],
	);

	return (
		<div
			className={cn(
				"absolute inset-0 z-20 flex min-h-0 flex-col bg-background",
				!visible && "hidden",
			)}
		>
			<header
				className={cn(
					"flex h-10 shrink-0 items-center border-b border-border bg-muted/20",
					reserveTrafficLights && TRAFFIC_LIGHT_GUTTER,
				)}
			>
				<Button
					variant="ghost"
					size="sm"
					className="ml-1 h-7 gap-1.5 px-2 text-xs text-muted-foreground"
					onClick={onClose}
				>
					<MessageSquare className="size-3.5" />
					聊天
				</Button>
				<div className="scrollbar-pro flex min-w-0 flex-1 items-stretch overflow-x-auto px-1">
					{tabs.map((tab) => (
						<div
							key={tab.path}
							className={cn(
								"group/tab flex max-w-56 shrink-0 items-center border-x border-transparent text-xs text-muted-foreground",
								activePath === tab.path &&
									"border-border bg-background text-foreground",
							)}
						>
							<button
								type="button"
								className="flex min-w-0 items-center gap-1.5 px-2.5 py-2"
								onClick={() => setActivePath(tab.path)}
							>
								<FileCode className="size-3.5 shrink-0" />
								<span className="truncate">{fileName(tab.path)}</span>
							</button>
							<button
								type="button"
								className="mr-1 rounded p-0.5 opacity-0 transition-opacity duration-100 hover:bg-muted group-hover/tab:opacity-100 focus-visible:opacity-100"
								aria-label={`关闭 ${fileName(tab.path)}`}
								onClick={() => closeTab(tab.path)}
							>
								<X className="size-3" />
							</button>
						</div>
					))}
				</div>
			</header>
			<div className="min-h-0 flex-1">
				{!activeTab ? (
					<EmptyState
						title="打开文件开始查看"
						description="可从文件引用或 Git 变更中打开文件。"
					/>
				) : activeTab.loading ? (
					<div className="flex h-full items-center justify-center text-xs text-muted-foreground">
						正在读取 {activeTab.path}…
					</div>
				) : activeTab.error ? (
					<EmptyState title="无法打开文件" description={activeTab.error} />
				) : highlightedHtml ? (
					<div
						className="project-file-highlight scrollbar-pro h-full overflow-auto bg-background"
						style={{
							fontFamily: getMonospaceFontFamilyStack(
								codeFontFamily,
								codeCustomFontFamily,
							),
							fontSize: codeFontSize,
						}}
						dangerouslySetInnerHTML={{ __html: highlightedHtml }}
					/>
				) : (
					<div className="scrollbar-pro h-full overflow-auto bg-background">
						<pre
							className="min-h-full min-w-max whitespace-pre p-3 text-foreground selection:bg-accent"
							style={{
								fontFamily: getMonospaceFontFamilyStack(
									codeFontFamily,
									codeCustomFontFamily,
								),
								fontSize: codeFontSize,
								lineHeight: 1.55,
								tabSize: 4,
							}}
						>
							<code>{activeTab.content}</code>
						</pre>
					</div>
				)}
			</div>
		</div>
	);
}
