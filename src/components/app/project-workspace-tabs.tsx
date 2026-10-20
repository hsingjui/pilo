import { useContext, useEffect, useRef, type ReactNode } from "react";
import {
	File,
	FileCode2,
	FileCog,
	FileJson2,
	FileText,
	GitBranch,
	Palette,
	SquareTerminal,
	X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";

import { ProjectWorkspaceContext } from "@/components/app/project-workspace-context";

import {
	EMPTY_PROJECT_WORKSPACE,
	type WorkspaceTab,
} from "@/lib/project-workspace";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";

function WorkspaceFileIcon({ path }: { path: string }) {
	const name = path.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
	let Icon = FileCode2;
	if (
		/\.(?:md|markdown|txt|log)$/.test(name) ||
		/^(?:readme|license)$/.test(name)
	)
		Icon = FileText;
	else if (/\.(?:json|jsonc|json5)$/.test(name)) Icon = FileJson2;
	else if (
		/\.(?:ya?ml|toml|ini|conf|cfg)$/.test(name) ||
		/^\.env(?:\.|$)/.test(name) ||
		/^(?:\.gitignore|\.dockerignore)$/.test(name)
	)
		Icon = FileCog;
	else if (
		/\.(?:sh|bash|zsh|fish|ps1|psm1|bat|cmd)$/.test(name) ||
		/^(?:dockerfile|makefile)$/.test(name)
	)
		Icon = SquareTerminal;
	else if (/\.(?:css|scss|sass|less)$/.test(name)) Icon = Palette;
	else if (!name.includes(".")) Icon = File;
	return <Icon aria-hidden="true" className="size-4 shrink-0" />;
}

const TAB_CLASS =
	"flex min-h-8 min-w-0 items-center gap-1.5 rounded-md border px-3 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11";

function CloseableWorkspaceTab({
	kind,
	path,
	label,
	hint,
	selected,
	onSelect,
	onClose,
	children,
}: {
	kind: "git" | "file";
	path?: string;
	label: string;
	hint: string;
	selected: boolean;
	onSelect: () => void;
	onClose: () => void;
	children: ReactNode;
}) {
	const { t } = useTranslation();
	return (
		<div
			role="presentation"
			onMouseDown={(event) => {
				if (event.button === 1) event.preventDefault();
			}}
			onAuxClick={(event) => {
				if (event.button !== 1) return;
				event.preventDefault();
				onClose();
			}}
			className={cn(
				"flex min-w-28 max-w-56 items-center rounded-md ring-1 ring-inset hover:bg-hover",
				selected ? "bg-muted/60 ring-border" : "ring-border/60",
			)}
		>
			<Hint label={hint}>
				<button
					type="button"
					role="tab"
					data-tab-kind={kind}
					data-file-path={path}
					aria-selected={selected}
					tabIndex={selected ? 0 : -1}
					onClick={onSelect}
					className={cn(
						TAB_CLASS,
						"flex-1 border-transparent pr-1",
						selected ? "text-foreground" : "text-muted-foreground",
					)}
				>
					{children}
					<span className="min-w-0 truncate">{label}</span>
				</button>
			</Hint>
			<button
				type="button"
				aria-label={t("file.closeFile", { name: label })}
				onClick={onClose}
				className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-hover hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [@media(pointer:coarse)]:size-11"
			>
				<X aria-hidden="true" className="size-3.5" />
			</button>
		</div>
	);
}

export function ProjectWorkspaceTabs({
	projectId,
	title,
	temporary,
	children,
}: {
	projectId?: string;
	title?: string;
	temporary?: boolean;
	children: ReactNode;
}) {
	const { t } = useTranslation();
	const workspace = useContext(ProjectWorkspaceContext);
	const { files, activeTab, gitOpen } =
		(projectId ? workspace?.state.get(projectId) : undefined) ??
		EMPTY_PROJECT_WORKSPACE;
	const showGit = isTauri() && gitOpen;
	const hasTabs = files.length > 0 || showGit;
	const listRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const selected = listRef.current?.querySelector<HTMLButtonElement>(
			'[role="tab"][aria-selected="true"]',
		);
		if (!selected || !listRef.current) return;
		const reveal = () => {
			if (getComputedStyle(selected).visibility === "hidden") return;
			const target =
				activeTab.kind === "chat" ? selected : selected.parentElement;
			target?.scrollIntoView({ block: "nearest", inline: "nearest" });
		};
		if (
			activeTab.kind !== "chat" &&
			getComputedStyle(selected).visibility !== "hidden"
		) {
			selected.focus({ preventScroll: true });
		}
		reveal();
		const observer = new ResizeObserver(reveal);
		observer.observe(listRef.current);
		return () => observer.disconnect();
	}, [activeTab]);
	const select = (tab: WorkspaceTab) => {
		if (!projectId || !workspace) return;
		if (tab.kind === "git") workspace.openGit(projectId);
		else workspace.selectFile(projectId, tab.kind === "file" ? tab.path : null);
	};
	const close = (tab: WorkspaceTab) => {
		if (!projectId || !workspace) return;
		const fallback = listRef.current
			?.closest("header")
			?.querySelector<HTMLButtonElement>("[data-open-git]");
		if (tab.kind === "git") workspace.closeGit(projectId);
		else if (tab.kind === "file") workspace.closeFile(projectId, tab.path);
		requestAnimationFrame(() => {
			const target =
				listRef.current?.querySelector<HTMLButtonElement>(
					'[role="tab"][aria-selected="true"]',
				) ?? fallback;
			target?.focus({ preventScroll: true });
		});
	};
	if (!title && !hasTabs) return <div className="min-w-0 flex-1" />;
	const chatTitle = title || t("app.newChat");
	return (
		<div
			ref={listRef}
			role="tablist"
			tabIndex={-1}
			aria-label={t("file.workspaceTabs")}
			className="scrollbar-pro flex min-w-0 flex-1 items-center gap-1 overflow-x-auto px-1"
			onKeyDown={(event) => {
				if (
					!(event.target instanceof HTMLButtonElement) ||
					event.target.getAttribute("role") !== "tab"
				)
					return;
				if (event.key === "Delete") {
					if (event.target.dataset.tabKind === "git") close({ kind: "git" });
					else if (event.target.dataset.filePath)
						close({ kind: "file", path: event.target.dataset.filePath });
					else return;
					event.preventDefault();
					return;
				}
				const tabs = Array.from(
					listRef.current?.querySelectorAll<HTMLButtonElement>(
						'[role="tab"]',
					) ?? [],
				);
				const current = tabs.indexOf(event.target);
				let index: number;
				switch (event.key) {
					case "ArrowRight":
						index = (current + 1) % tabs.length;
						break;
					case "ArrowLeft":
						index = (current - 1 + tabs.length) % tabs.length;
						break;
					case "Home":
						index = 0;
						break;
					case "End":
						index = tabs.length - 1;
						break;
					default:
						return;
				}
				event.preventDefault();
				tabs[index]?.focus();
				tabs[index]?.click();
			}}
		>
			<Hint label={chatTitle}>
				<button
					type="button"
					role="tab"
					aria-selected={activeTab.kind === "chat"}
					tabIndex={activeTab.kind === "chat" ? 0 : -1}
					onClick={() => select({ kind: "chat" })}
					className={cn(
						TAB_CLASS,
						hasTabs ? "min-w-24 max-w-56" : "max-w-[66.666667%]",
						temporary ? "border-dashed border-border" : "border-transparent",
						activeTab.kind === "chat"
							? "text-foreground"
							: "text-muted-foreground hover:bg-hover",
						hasTabs && activeTab.kind === "chat" && "bg-muted/60",
					)}
				>
					{children}
					<span className="min-w-0 truncate">{chatTitle}</span>
				</button>
			</Hint>
			{showGit ? (
				<CloseableWorkspaceTab
					kind="git"
					label="Git"
					hint={t("file.viewChanges")}
					selected={activeTab.kind === "git"}
					onSelect={() => select({ kind: "git" })}
					onClose={() => close({ kind: "git" })}
				>
					<GitBranch aria-hidden="true" className="size-4 shrink-0" />
				</CloseableWorkspaceTab>
			) : null}
			{files.map((file) => (
				<CloseableWorkspaceTab
					key={file.path}
					kind="file"
					path={file.path}
					label={file.path.split(/[\\/]/).at(-1) ?? file.path}
					hint={file.path}
					selected={activeTab.kind === "file" && activeTab.path === file.path}
					onSelect={() => select({ kind: "file", path: file.path })}
					onClose={() => close({ kind: "file", path: file.path })}
				>
					<WorkspaceFileIcon path={file.path} />
				</CloseableWorkspaceTab>
			))}
		</div>
	);
}
