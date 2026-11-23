import {
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import {
	ChevronDown,
	File,
	FileCode2,
	FileCog,
	FileJson2,
	FileText,
	Palette,
	SquareTerminal,
	X,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { ProjectWorkspaceContext } from "@/components/app/project-workspace-context";

import {
	EMPTY_PROJECT_WORKSPACE,
	type WorkspaceTab,
} from "@shared/project-workspace";
import {
	computeMaxVisibleAuxTabs,
	partitionHeaderTabs,
	workspaceFileIconKind,
	type WorkspaceFileIconKind,
} from "@shared/project-workspace-tabs";
import { cn } from "@/lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/ui/dropdown-menu";
import { Hint } from "@/ui/tooltip";

const FILE_ICON_COMPONENTS: Record<WorkspaceFileIconKind, typeof FileCode2> = {
	text: FileText,
	json: FileJson2,
	config: FileCog,
	terminal: SquareTerminal,
	style: Palette,
	file: File,
	code: FileCode2,
};

function WorkspaceFileIcon({ path }: { path: string }) {
	const Icon = FILE_ICON_COMPONENTS[workspaceFileIconKind(path)];
	return <Icon aria-hidden="true" className="size-3.5 shrink-0" />;
}

const TAB_CLASS =
	"flex h-7 min-w-0 items-center gap-1.5 rounded-md border px-2 text-sm outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11";

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
				"group flex h-7 max-w-44 shrink-0 items-center rounded-md border transition-colors [@media(pointer:coarse)]:min-h-11",
				selected
					? "border-border/70 bg-secondary"
					: "border-transparent hover:bg-hover/70",
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
						"h-full flex-1 border-transparent pl-2 pr-0.5",
						selected
							? "font-medium text-foreground"
							: "text-muted-foreground group-hover:text-foreground",
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
				className={cn(
					"mr-0.5 flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-opacity hover:bg-hover hover:text-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring [@media(pointer:coarse)]:size-11 [@media(pointer:coarse)]:opacity-100",
					selected
						? "opacity-100"
						: "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
				)}
			>
				<X aria-hidden="true" className="size-3" />
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
	const { files, activeTab } =
		(projectId ? workspace?.state.get(projectId) : undefined) ??
		EMPTY_PROJECT_WORKSPACE;
	const hasTabs = files.length > 0;
	const showTablist = Boolean(title) || hasTabs;
	const listRef = useRef<HTMLDivElement>(null);
	const [containerWidth, setContainerWidth] = useState(0);

	useEffect(() => {
		if (!showTablist) return;
		const element = listRef.current;
		if (!element) return;
		const measure = () => setContainerWidth(element.clientWidth);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, [showTablist]);

	const fileItems = useMemo(
		() =>
			files.map((file) => ({
				id: `file:${file.path}`,
				file,
				label: file.path.split(/[\\/]/).at(-1) ?? file.path,
			})),
		[files],
	);
	const activeFileId =
		activeTab.kind === "file" ? `file:${activeTab.path}` : null;
	const maxVisible = computeMaxVisibleAuxTabs(
		containerWidth,
		Boolean(title) || hasTabs,
	);
	const { visible, overflow } = useMemo(
		() => partitionHeaderTabs(fileItems, activeFileId, maxVisible),
		[fileItems, activeFileId, maxVisible],
	);

	useEffect(() => {
		const selected = listRef.current?.querySelector<HTMLButtonElement>(
			'[role="tab"][aria-selected="true"]',
		);
		if (!selected || !listRef.current) return;
		if (
			activeTab.kind !== "chat" &&
			getComputedStyle(selected).visibility !== "hidden"
		) {
			selected.focus({ preventScroll: true });
		}
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
	const chatSelected = activeTab.kind === "chat";
	return (
		<div
			ref={listRef}
			role="tablist"
			tabIndex={-1}
			aria-label={t("file.workspaceTabs")}
			className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden px-1"
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
					aria-selected={chatSelected}
					tabIndex={chatSelected ? 0 : -1}
					onClick={() => select({ kind: "chat" })}
					className={cn(
						TAB_CLASS,
						hasTabs ? "min-w-20 max-w-48 shrink" : "max-w-[66.666667%]",
						temporary
							? chatSelected && hasTabs
								? "border-dashed border-border bg-secondary"
								: "border-dashed border-border/70"
							: hasTabs && chatSelected
								? "border-border/70 bg-secondary"
								: "border-transparent",
						chatSelected
							? hasTabs
								? "font-medium text-foreground"
								: "text-foreground"
							: "text-muted-foreground hover:bg-hover/70 hover:text-foreground",
					)}
				>
					{children}
					<span className="min-w-0 truncate">{chatTitle}</span>
				</button>
			</Hint>
			{hasTabs ? (
				<span
					aria-hidden="true"
					className="mx-0.5 h-3.5 w-px shrink-0 bg-border/80"
				/>
			) : null}
			{visible.map(({ file, label }) => (
				<CloseableWorkspaceTab
					key={file.path}
					kind="file"
					path={file.path}
					label={label}
					hint={file.path}
					selected={activeTab.kind === "file" && activeTab.path === file.path}
					onSelect={() => select({ kind: "file", path: file.path })}
					onClose={() => close({ kind: "file", path: file.path })}
				>
					<WorkspaceFileIcon path={file.path} />
				</CloseableWorkspaceTab>
			))}
			{overflow.length > 0 ? (
				<DropdownMenu>
					<Hint label={t("file.moreTabs", { count: overflow.length })}>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								aria-label={t("file.moreTabs", { count: overflow.length })}
								className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/60 px-2 font-mono text-xs text-muted-foreground outline-hidden transition-colors hover:bg-hover/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [@media(pointer:coarse)]:min-h-11"
							>
								<span>{`+${overflow.length}`}</span>
								<ChevronDown aria-hidden="true" className="size-3" />
							</button>
						</DropdownMenuTrigger>
					</Hint>
					<DropdownMenuContent align="start" className="w-60">
						{overflow.map(({ file, label }) => (
							<DropdownMenuItem
								key={file.path}
								icon={<WorkspaceFileIcon path={file.path} />}
								onSelect={() => select({ kind: "file", path: file.path })}
							>
								<span className="min-w-0 flex-1 truncate">{label}</span>
							</DropdownMenuItem>
						))}
					</DropdownMenuContent>
				</DropdownMenu>
			) : null}
		</div>
	);
}
