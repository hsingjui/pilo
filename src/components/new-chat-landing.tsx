import { useCallback, useEffect, useRef, useState } from "react";
import { PanelLeft } from "lucide-react";
import { ChatComposer } from "@/components/chat/chat-composer";
import {
	PI_THINKING_LEVELS,
	runtimeErrorMessage,
	type PiModel,
	type PiThinkingLevel,
} from "@/lib/pi-runtime";
import {
	getCachedWorkspacePiModels,
	refreshWorkspacePiModels,
} from "@/lib/pi-models";
import { cn } from "@/lib/utils";
import { IS_MACOS } from "@/components/title-bar";
import type { Workspace } from "@/lib/workspaces";
import { Button } from "@/ui";

export function NewChatLanding({
	onStartSession,
	onExpandSidebar,
	reserveWindowControls = false,
	sidebarCollapsed = false,
	workspaceAvailable = true,
	workspace = null,
}: {
	onStartSession: (
		prompt: string,
		model: PiModel | null,
		thinkingLevel: PiThinkingLevel | null,
	) => void;
	onExpandSidebar?: () => void;
	reserveWindowControls?: boolean;
	sidebarCollapsed?: boolean;
	workspaceAvailable?: boolean;
	workspace?: Workspace | null;
}) {
	const workspaceId = workspace?.id ?? null;
	const cachedModels = workspaceId
		? getCachedWorkspacePiModels(workspaceId)
		: null;
	const [draft, setDraft] = useState("");
	const [models, setModels] = useState<PiModel[]>(cachedModels?.models ?? []);
	const [selectedModel, setSelectedModel] = useState<PiModel | null>(null);
	const [selectedThinkingLevel, setSelectedThinkingLevel] =
		useState<PiThinkingLevel | null>(null);
	const [modelLoadState, setModelLoadState] = useState<
		"idle" | "loading" | "ready" | "error"
	>(cachedModels ? "ready" : "idle");
	const [modelError, setModelError] = useState<string | null>(null);
	const modelRequestRef = useRef(0);
	const modelLoadingRef = useRef(false);

	const loadModels = useCallback(async () => {
		if (!workspaceId || modelLoadingRef.current) return;
		const requestId = ++modelRequestRef.current;
		modelLoadingRef.current = true;
		setModelLoadState("loading");
		setModelError(null);
		try {
			const result = await refreshWorkspacePiModels(workspaceId);
			if (modelRequestRef.current !== requestId) return;
			setModels(result.models);
			setModelLoadState("ready");
		} catch (error) {
			if (modelRequestRef.current !== requestId) return;
			setModelError(runtimeErrorMessage(error));
			setModelLoadState("error");
		} finally {
			if (modelRequestRef.current === requestId) {
				modelLoadingRef.current = false;
			}
		}
	}, [workspaceId]);

	useEffect(() => {
		if (!workspaceId) return;
		const timer = window.setTimeout(() => void loadModels(), 0);
		return () => {
			window.clearTimeout(timer);
			modelRequestRef.current += 1;
			modelLoadingRef.current = false;
		};
	}, [loadModels, workspaceId]);

	return (
		<div className="relative flex h-full min-w-0 flex-col">
			{/* 与 Lody 一样，桌面拖拽条悬浮在内容之上，不占 Landing 的垂直布局。 */}
			<div
				aria-hidden="true"
				data-tauri-drag-region="deep"
				className={cn(
					"absolute inset-x-0 top-0 z-10 h-11",
					reserveWindowControls && "pr-[7.75rem]",
				)}
			/>
			{sidebarCollapsed && (
				<Button
					variant="ghost"
					size="icon"
					className={cn(
						"absolute z-20 size-7 shrink-0",
						IS_MACOS ? "left-24 top-[9px]" : "left-3 top-2",
					)}
					aria-label="展开侧边栏"
					onClick={onExpandSidebar}
				>
					<PanelLeft className="size-4" />
				</Button>
			)}
			<div className="flex min-h-0 flex-1 items-center justify-center overflow-auto px-4">
				<div className="flex flex-col items-center justify-center gap-3 text-center">
					<svg viewBox="0 0 800 800" className="h-16 w-16" aria-hidden="true">
						<path
							className="fill-foreground"
							fillRule="evenodd"
							d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
						/>
						<path
							className="fill-foreground"
							d="M517.36 400H634.72V634.72H517.36Z"
						/>
					</svg>
					<h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
						{workspaceAvailable ? "今天想做点什么？" : "先添加一个工作区"}
					</h1>
				</div>
			</div>
			<div className="mx-auto w-full max-w-[46rem] px-3 pb-2 sm:px-4">
				<ChatComposer
					variant="landing"
					value={draft}
					onChange={setDraft}
					onSubmit={(prompt) =>
						onStartSession(prompt, selectedModel, selectedThinkingLevel)
					}
					disabled={!workspaceAvailable}
					models={models}
					selectedModel={selectedModel}
					modelLoading={modelLoadState === "loading"}
					modelError={modelError}
					modelDisabled={!workspaceAvailable || !workspace}
					showDefaultModelOption
					onModelMenuOpen={() => {
						if (modelLoadState === "idle" || modelLoadState === "error") {
							void loadModels();
						}
					}}
					onModelChange={setSelectedModel}
					thinkingLevels={PI_THINKING_LEVELS}
					selectedThinkingLevel={selectedThinkingLevel}
					thinkingDisabled={!workspaceAvailable || !workspace}
					showDefaultThinkingOption
					onThinkingChange={setSelectedThinkingLevel}
					placeholder={
						workspaceAvailable
							? undefined
							: "请先在设置 → 工作区中添加 Local、WSL 或 SSH 工作区"
					}
				/>
			</div>
		</div>
	);
}
