import {
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ChangeEvent,
	type KeyboardEvent,
} from "react";
import {
	ArrowUp,
	Bot,
	Check,
	FileCode2,
	FileText,
	ListPlus,
	LoaderCircle,
	Plus,
	Sparkles,
	Square,
	TerminalSquare,
	X,
} from "lucide-react";

import { isImeComposingKeyboardEvent } from "@/lib/ime";
import type { PiModel, PiThinkingLevel } from "@/lib/pi-runtime";
import { usePreferences } from "@/lib/preferences-provider";
import { cn } from "@/lib/utils";
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
	Textarea,
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/ui";

export type ComposerAttachment = {
	id: string;
	name: string;
};

export type ComposerSuggestionKind = "file" | "command" | "skill";

export type ComposerSuggestion = {
	kind: ComposerSuggestionKind;
	value: string;
	label: string;
	detail?: string;
};

type ChatComposerProps = {
	value: string;
	onChange: (value: string) => void;
	onSubmit?: (value: string) => void;
	onSteer?: (value: string) => void;
	onFollowUp?: (value: string) => void;
	variant?: "landing" | "session";
	placeholder?: string;
	disabled?: boolean;
	running?: boolean;
	onStop?: () => void;
	pendingSteering?: number;
	pendingFollowUps?: number;
	statusText?: string;
	modelLabel?: string;
	models?: readonly PiModel[];
	selectedModel?: PiModel | null;
	modelLoading?: boolean;
	modelError?: string | null;
	modelDisabled?: boolean;
	showDefaultModelOption?: boolean;
	onModelMenuOpen?: () => void;
	onModelChange?: (model: PiModel | null) => void;
	thinkingLevels?: readonly PiThinkingLevel[];
	selectedThinkingLevel?: PiThinkingLevel | null;
	thinkingLoading?: boolean;
	thinkingDisabled?: boolean;
	showDefaultThinkingOption?: boolean;
	onThinkingMenuOpen?: () => void;
	onThinkingChange?: (level: PiThinkingLevel | null) => void;
	suggestions?: readonly ComposerSuggestion[];
	className?: string;
};

type SuggestionTrigger = "@" | "/" | "$";

type ActiveSuggestionQuery = {
	trigger: SuggestionTrigger;
	query: string;
	start: number;
	end: number;
};

const MAX_ROWS = 12;
const LINE_HEIGHT = 24;
const DEFAULT_MODEL_VALUE = "__pilo_default_model__";
const DEFAULT_THINKING_VALUE = "__pilo_default_thinking__";
const EMPTY_MODELS: readonly PiModel[] = [];
const EMPTY_THINKING_LEVELS: readonly PiThinkingLevel[] = [];
const THINKING_LEVEL_LABELS: Record<PiThinkingLevel, string> = {
	off: "关闭",
	minimal: "最低",
	low: "低",
	medium: "中",
	high: "高",
	xhigh: "极高",
	max: "最大",
};

function thinkingLevelLabel(level: PiThinkingLevel | null) {
	return level ? THINKING_LEVEL_LABELS[level] : "默认";
}

function modelValue(model: PiModel) {
	return JSON.stringify([model.provider, model.id]);
}

const DEFAULT_SUGGESTIONS: readonly ComposerSuggestion[] = [
	{
		kind: "file",
		value: "@src/App.tsx",
		label: "src/App.tsx",
		detail: "应用入口",
	},
	{
		kind: "file",
		value: "@src/components/chat/chat-page.tsx",
		label: "src/components/chat/chat-page.tsx",
		detail: "聊天页面",
	},
	{
		kind: "file",
		value: "@src/components/chat/chat-composer.tsx",
		label: "src/components/chat/chat-composer.tsx",
		detail: "输入框",
	},
	{
		kind: "file",
		value: "@src-tauri/src/lib.rs",
		label: "src-tauri/src/lib.rs",
		detail: "Tauri Runtime",
	},
	{
		kind: "command",
		value: "/model",
		label: "/model",
		detail: "切换模型",
	},
	{
		kind: "command",
		value: "/compact",
		label: "/compact",
		detail: "压缩当前上下文",
	},
	{
		kind: "command",
		value: "/new",
		label: "/new",
		detail: "新建会话",
	},
	{
		kind: "command",
		value: "/help",
		label: "/help",
		detail: "查看 Pi 命令",
	},
	{
		kind: "skill",
		value: "$review",
		label: "review",
		detail: "代码审查",
	},
	{
		kind: "skill",
		value: "$frontend",
		label: "frontend",
		detail: "前端实现",
	},
	{
		kind: "skill",
		value: "$debug",
		label: "debug",
		detail: "问题排查",
	},
];

const TRIGGER_META: Record<
	SuggestionTrigger,
	{ kind: ComposerSuggestionKind; title: string; hint: string }
> = {
	"@": { kind: "file", title: "文件", hint: "输入路径筛选" },
	"/": { kind: "command", title: "命令", hint: "Pi commands" },
	$: { kind: "skill", title: "技能", hint: "Pi skills" },
};

function activeSuggestionQuery(
	value: string,
	caret: number,
): ActiveSuggestionQuery | null {
	const beforeCaret = value.slice(0, caret);
	const match = /(^|\s)([@/$])([^\s]*)$/.exec(beforeCaret);
	if (!match) return null;
	const trigger = match[2] as SuggestionTrigger;
	const query = match[3] ?? "";
	return {
		trigger,
		query,
		start: caret - query.length - 1,
		end: caret,
	};
}

function SuggestionIcon({ kind }: { kind: ComposerSuggestionKind }) {
	if (kind === "file") return <FileCode2 className="size-3.5" />;
	if (kind === "command") return <TerminalSquare className="size-3.5" />;
	return <Sparkles className="size-3.5" />;
}

export function ChatComposer({
	value,
	onChange,
	onSubmit,
	onSteer,
	onFollowUp,
	variant: _variant = "session",
	placeholder = "按 @ 提及文件，/ 使用命令，$ 使用技能",
	disabled = false,
	running = false,
	onStop,
	pendingSteering = 0,
	pendingFollowUps = 0,
	statusText = "",
	modelLabel = "Pi 默认",
	models = EMPTY_MODELS,
	selectedModel = null,
	modelLoading = false,
	modelError = null,
	modelDisabled = false,
	showDefaultModelOption = false,
	onModelMenuOpen,
	onModelChange,
	thinkingLevels = EMPTY_THINKING_LEVELS,
	selectedThinkingLevel = null,
	thinkingLoading = false,
	thinkingDisabled = false,
	showDefaultThinkingOption = false,
	onThinkingMenuOpen,
	onThinkingChange,
	suggestions = DEFAULT_SUGGESTIONS,
	className,
}: ChatComposerProps) {
	const { sendMessageShortcut } = usePreferences();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
	const [caret, setCaret] = useState(value.length);
	const [highlightedIndex, setHighlightedIndex] = useState(0);
	const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
	const effectiveModelLabel =
		selectedModel?.name || selectedModel?.id || modelLabel;
	const selectedModelValue = selectedModel
		? modelValue(selectedModel)
		: showDefaultModelOption
			? DEFAULT_MODEL_VALUE
			: "";
	const selectedThinkingValue =
		selectedThinkingLevel ??
		(showDefaultThinkingOption ? DEFAULT_THINKING_VALUE : "");
	const effectiveThinkingLabel = thinkingLevelLabel(selectedThinkingLevel);
	const runConfigDisabled =
		(modelDisabled || !onModelChange) &&
		(thinkingDisabled || !onThinkingChange);

	useLayoutEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		textarea.style.height = "auto";
		const maxHeight = MAX_ROWS * LINE_HEIGHT + 16;
		const nextHeight = Math.min(textarea.scrollHeight, maxHeight);
		textarea.style.height = `${Math.max(48, nextHeight)}px`;
		textarea.style.overflowY =
			textarea.scrollHeight > maxHeight ? "auto" : "hidden";
	});

	const activeQuery = useMemo(
		() => activeSuggestionQuery(value, Math.min(caret, value.length)),
		[value, caret],
	);
	const activeKey = activeQuery
		? `${activeQuery.start}:${activeQuery.trigger}:${activeQuery.query}`
		: null;
	const queryMeta = activeQuery ? TRIGGER_META[activeQuery.trigger] : null;
	const filteredSuggestions = useMemo(() => {
		if (!activeQuery || !queryMeta) return [];
		const query = activeQuery.query.toLowerCase();
		return suggestions
			.filter((suggestion) => suggestion.kind === queryMeta.kind)
			.filter((suggestion) => {
				if (!query) return true;
				return [suggestion.label, suggestion.value, suggestion.detail]
					.filter(Boolean)
					.some((part) => part!.toLowerCase().includes(query));
			})
			.slice(0, 9);
	}, [activeQuery, queryMeta, suggestions]);
	const suggestionMenuOpen = Boolean(
		activeQuery && activeKey !== dismissedQuery,
	);
	const effectiveHighlightedIndex =
		filteredSuggestions.length > 0
			? Math.min(highlightedIndex, filteredSuggestions.length - 1)
			: 0;

	const submit = () => {
		const trimmed = value.trim();
		if (!trimmed || disabled) return;
		if (running) {
			onSteer?.(trimmed);
			return;
		}
		onSubmit?.(trimmed);
	};

	const submitFollowUp = () => {
		const trimmed = value.trim();
		if (!trimmed || disabled || !running) return;
		onFollowUp?.(trimmed);
	};

	const selectSuggestion = (suggestion: ComposerSuggestion) => {
		if (!activeQuery) return;
		const inserted = `${suggestion.value} `;
		const nextValue = `${value.slice(0, activeQuery.start)}${inserted}${value.slice(activeQuery.end)}`;
		const nextCaret = activeQuery.start + inserted.length;
		onChange(nextValue);
		setCaret(nextCaret);
		setDismissedQuery(
			`${activeQuery.start}:${activeQuery.trigger}:__selected__`,
		);
		requestAnimationFrame(() => {
			const textarea = textareaRef.current;
			if (!textarea) return;
			textarea.focus();
			textarea.setSelectionRange(nextCaret, nextCaret);
		});
	};

	const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
		const primaryShortcutModifierMatches =
			sendMessageShortcut === "enter"
				? !event.ctrlKey && !event.metaKey
				: event.ctrlKey || event.metaKey;
		const shouldFollowUpWithEnter =
			running &&
			event.key === "Enter" &&
			event.altKey &&
			!event.shiftKey &&
			!isImeComposingKeyboardEvent(event) &&
			primaryShortcutModifierMatches;

		if (shouldFollowUpWithEnter) {
			event.preventDefault();
			submitFollowUp();
			return;
		}

		if (suggestionMenuOpen && !isImeComposingKeyboardEvent(event)) {
			if (event.key === "ArrowDown" && filteredSuggestions.length > 0) {
				event.preventDefault();
				setHighlightedIndex(
					(index) => (index + 1) % filteredSuggestions.length,
				);
				return;
			}
			if (event.key === "ArrowUp" && filteredSuggestions.length > 0) {
				event.preventDefault();
				setHighlightedIndex(
					(index) =>
						(index - 1 + filteredSuggestions.length) %
						filteredSuggestions.length,
				);
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setDismissedQuery(activeKey);
				return;
			}
			if (
				event.key === "Enter" &&
				filteredSuggestions[effectiveHighlightedIndex]
			) {
				event.preventDefault();
				selectSuggestion(filteredSuggestions[effectiveHighlightedIndex]);
				return;
			}
		}

		const shouldSubmitWithEnter =
			event.key === "Enter" &&
			!event.shiftKey &&
			!event.altKey &&
			!isImeComposingKeyboardEvent(event) &&
			primaryShortcutModifierMatches;

		if (shouldSubmitWithEnter) {
			event.preventDefault();
			submit();
		}
	};

	const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
		const files = Array.from(event.target.files ?? []);
		if (files.length === 0) return;
		setAttachments((current) => [
			...current,
			...files.map((file) => ({
				id: `${file.name}-${file.size}-${file.lastModified}`,
				name: file.name,
			})),
		]);
		event.target.value = "";
	};

	const syncCaret = () => {
		const textarea = textareaRef.current;
		if (!textarea) return;
		setCaret(textarea.selectionStart ?? value.length);
	};

	return (
		<div className={cn("relative w-full", className)}>
			{suggestionMenuOpen ? (
				<div
					role="menu"
					aria-label={`${queryMeta?.title ?? "输入"}建议`}
					className="absolute bottom-[calc(100%+8px)] left-0 z-40 w-full max-w-[640px] overflow-hidden rounded-lg border border-border bg-popover text-popover-foreground shadow-lg"
				>
					<div className="flex h-8 items-center gap-2 border-b border-border/70 px-2.5 text-[11px] text-muted-foreground">
						<span className="flex size-5 items-center justify-center rounded bg-muted font-mono text-foreground">
							{activeQuery?.trigger}
						</span>
						<span className="font-medium text-foreground/85">
							{queryMeta?.title}
						</span>
						<span className="truncate">{queryMeta?.hint}</span>
						<span className="ml-auto hidden sm:inline">
							↑↓ 选择 · Enter 插入 · Esc 关闭
						</span>
					</div>
					<div className="scrollbar-pro max-h-60 overflow-y-auto p-1">
						{filteredSuggestions.length > 0 ? (
							filteredSuggestions.map((suggestion, index) => (
								<button
									key={`${suggestion.kind}:${suggestion.value}`}
									type="button"
									role="menuitem"
									aria-current={
										index === effectiveHighlightedIndex ? "true" : undefined
									}
									tabIndex={-1}
									className={cn(
										"flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs outline-hidden transition-colors",
										index === effectiveHighlightedIndex
											? "bg-hover text-hover-foreground"
											: "text-popover-foreground hover:bg-hover/70",
									)}
									onMouseDown={(event) => event.preventDefault()}
									onPointerMove={() => setHighlightedIndex(index)}
									onClick={() => selectSuggestion(suggestion)}
								>
									<span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border/60 bg-muted/35 text-muted-foreground">
										<SuggestionIcon kind={suggestion.kind} />
									</span>
									<span className="min-w-0 flex-1 truncate font-mono text-[11px]">
										{suggestion.label}
									</span>
									{suggestion.detail ? (
										<span className="max-w-44 shrink-0 truncate text-[11px] text-muted-foreground">
											{suggestion.detail}
										</span>
									) : null}
								</button>
							))
						) : (
							<div className="px-3 py-5 text-center text-xs text-muted-foreground">
								没有匹配的{queryMeta?.title ?? "项目"}
							</div>
						)}
					</div>
				</div>
			) : null}

			<div
				className={cn(
					"group relative flex w-full flex-col border bg-background transition-colors duration-150",
					"border-foreground/[0.10] focus-within:border-ring/40",
					"dark:border-input-border/70",
					// Lody 桌面端 Landing 实际复用 session composer 的紧凑壳；
					// landing 这里只保留交互语义（例如附件入口图标），不再放大输入框。
					"gap-1 rounded-xl px-2 py-1.5 dark:bg-input/90",
				)}
			>
				{attachments.length > 0 ? (
					<div className="flex flex-wrap gap-1.5 px-1 pb-1">
						{attachments.map((attachment) => (
							<div
								key={attachment.id}
								className="flex max-w-56 items-center gap-1.5 rounded-lg border border-border/70 bg-muted/45 px-2 py-1.5 text-xs"
							>
								<FileText className="size-3.5 shrink-0 text-muted-foreground" />
								<span className="min-w-0 truncate">{attachment.name}</span>
								<button
									type="button"
									aria-label={`移除 ${attachment.name}`}
									className="ml-1 rounded-sm text-muted-foreground hover:text-foreground"
									onClick={() =>
										setAttachments((items) =>
											items.filter((item) => item.id !== attachment.id),
										)
									}
								>
									<X className="size-3" />
								</button>
							</div>
						))}
					</div>
				) : null}

				<Textarea
					ref={textareaRef}
					value={value}
					onChange={(event) => {
						onChange(event.target.value);
						setCaret(event.target.selectionStart ?? event.target.value.length);
						setHighlightedIndex(0);
						setDismissedQuery(null);
					}}
					onSelect={syncCaret}
					onClick={syncCaret}
					onKeyUp={syncCaret}
					onKeyDown={handleKeyDown}
					disabled={disabled}
					rows={2}
					placeholder={placeholder}
					className={cn(
						"input-scrollbar resize-none border-transparent bg-transparent text-sm leading-6 shadow-none",
						"focus-visible:ring-0 focus-visible:ring-offset-0",
						"text-input-foreground placeholder:text-input-placeholder",
						"min-h-12 px-1 py-0",
					)}
				/>

				<div className="flex select-none items-center gap-2 pt-0.5">
					<input
						ref={fileInputRef}
						type="file"
						multiple
						className="hidden"
						onChange={handleFiles}
					/>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="size-7 rounded-md text-muted-foreground"
								aria-label="添加附件"
								onClick={() => fileInputRef.current?.click()}
							>
								<Plus className="size-4" />
							</Button>
						</TooltipTrigger>
						<TooltipContent>添加附件</TooltipContent>
					</Tooltip>

					<DropdownMenu
						onOpenChange={(open) => {
							if (!open) return;
							onModelMenuOpen?.();
							onThinkingMenuOpen?.();
						}}
					>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								disabled={runConfigDisabled}
								aria-label="运行配置"
								className={cn(
									"inline-flex h-7 min-w-0 select-none items-center gap-1.5 rounded-[4px] px-2 text-xs leading-tight",
									"text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
									"data-[state=open]:bg-muted data-[state=open]:text-foreground disabled:cursor-default disabled:opacity-70",
								)}
							>
								<Bot className="size-4 shrink-0" />
								<span className="block min-w-0 max-w-40 truncate text-left">
									{effectiveModelLabel}
								</span>
								<span
									aria-hidden="true"
									className="shrink-0 text-muted-foreground/60"
								>
									·
								</span>
								<span className="shrink-0">{effectiveThinkingLabel}</span>
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="start" className="min-w-56">
							<DropdownMenuSub>
								<DropdownMenuSubTrigger
									className="pr-1.5"
									disabled={modelDisabled || !onModelChange}
								>
									<span className="min-w-0 flex-1 truncate">模型</span>
									<span className="ml-4 max-w-40 truncate text-xs text-muted-foreground">
										{modelLoading ? "加载中…" : effectiveModelLabel}
									</span>
								</DropdownMenuSubTrigger>
								<DropdownMenuSubContent className="max-h-80 min-w-64 overflow-y-auto">
									{modelLoading ? (
										<DropdownMenuItem disabled>
											<LoaderCircle className="size-3.5 animate-spin" />
											正在读取 Pi 模型…
										</DropdownMenuItem>
									) : modelError ? (
										<DropdownMenuItem
											onSelect={(event) => {
												event.preventDefault();
												onModelMenuOpen?.();
											}}
										>
											<span className="min-w-0 flex-1 truncate">
												{modelError}
											</span>
											<span className="text-xs text-muted-foreground">
												重试
											</span>
										</DropdownMenuItem>
									) : models.length === 0 && !showDefaultModelOption ? (
										<DropdownMenuItem disabled>没有可用模型</DropdownMenuItem>
									) : (
										<>
											{showDefaultModelOption ? (
												<DropdownMenuItem
													onSelect={(event) => {
														event.preventDefault();
														onModelChange?.(null);
													}}
													className="justify-between"
												>
													<span>Pi 默认模型</span>
													{selectedModelValue === DEFAULT_MODEL_VALUE ? (
														<Check className="size-3.5 opacity-70" />
													) : null}
												</DropdownMenuItem>
											) : null}
											{models.map((model) => {
												const optionValue = modelValue(model);
												return (
													<DropdownMenuItem
														key={optionValue}
														onSelect={(event) => {
															event.preventDefault();
															onModelChange?.(model);
														}}
														className="gap-2"
													>
														<span className="min-w-0 flex-1 truncate">
															{model.name || model.id}
														</span>
														<span className="shrink-0 text-xs text-muted-foreground">
															{model.provider}
														</span>
														{selectedModelValue === optionValue ? (
															<Check className="size-3.5 shrink-0 opacity-70" />
														) : null}
													</DropdownMenuItem>
												);
											})}
										</>
									)}
								</DropdownMenuSubContent>
							</DropdownMenuSub>

							<DropdownMenuSub>
								<DropdownMenuSubTrigger
									className="pr-1.5"
									disabled={thinkingDisabled || !onThinkingChange}
								>
									<span className="min-w-0 flex-1 truncate">推理</span>
									<span className="ml-4 max-w-40 truncate text-xs text-muted-foreground">
										{thinkingLoading ? "加载中…" : effectiveThinkingLabel}
									</span>
								</DropdownMenuSubTrigger>
								<DropdownMenuSubContent className="min-w-40">
									{thinkingLoading ? (
										<DropdownMenuItem disabled>
											正在读取推理等级…
										</DropdownMenuItem>
									) : (
										<>
											{showDefaultThinkingOption ? (
												<DropdownMenuItem
													onSelect={(event) => {
														event.preventDefault();
														onThinkingChange?.(null);
													}}
													className="justify-between"
												>
													<span>Pi 默认等级</span>
													{selectedThinkingValue === DEFAULT_THINKING_VALUE ? (
														<Check className="size-3.5 opacity-70" />
													) : null}
												</DropdownMenuItem>
											) : null}
											{thinkingLevels.map((level) => (
												<DropdownMenuItem
													key={level}
													onSelect={(event) => {
														event.preventDefault();
														onThinkingChange?.(level);
													}}
													className="justify-between"
												>
													<span>{thinkingLevelLabel(level)}</span>
													{selectedThinkingValue === level ? (
														<Check className="size-3.5 opacity-70" />
													) : null}
												</DropdownMenuItem>
											))}
										</>
									)}
								</DropdownMenuSubContent>
							</DropdownMenuSub>
						</DropdownMenuContent>
					</DropdownMenu>

					{pendingSteering > 0 || pendingFollowUps > 0 ? (
						<span className="hidden text-[11px] tabular-nums text-muted-foreground sm:inline">
							{pendingSteering > 0 ? `调整 ${pendingSteering}` : null}
							{pendingSteering > 0 && pendingFollowUps > 0 ? " · " : null}
							{pendingFollowUps > 0 ? `稍后 ${pendingFollowUps}` : null}
						</span>
					) : null}
					{statusText ? (
						<span className="hidden truncate text-[11px] tabular-nums text-muted-foreground md:inline">
							{statusText}
						</span>
					) : null}

					<div className="ml-auto flex shrink-0 items-center gap-1.5">
						{running ? (
							<>
								<Tooltip>
									<TooltipTrigger asChild>
										<Button
											type="button"
											variant="ghost"
											size="icon"
											className="size-7 rounded-full bg-foreground text-background shadow-xs transition-all hover:bg-foreground/90 hover:text-background active:translate-y-px"
											aria-label="停止"
											onClick={onStop}
										>
											<Square className="size-2.5 fill-current" />
										</Button>
									</TooltipTrigger>
									<TooltipContent>停止</TooltipContent>
								</Tooltip>
								{value.trim() ? (
									<>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													type="button"
													variant="outline"
													size="icon"
													className="size-7 rounded-md active:scale-[0.96]"
													aria-label="回复结束后发送"
													disabled={!onFollowUp}
													onClick={submitFollowUp}
												>
													<ListPlus className="size-3.5" />
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												回复完成后发送 ·{" "}
												{sendMessageShortcut === "enter"
													? "Alt Enter"
													: "Ctrl/⌘ Alt Enter"}
											</TooltipContent>
										</Tooltip>
										<Tooltip>
											<TooltipTrigger asChild>
												<Button
													type="button"
													size="icon"
													className={cn(
														"size-7 rounded-full bg-foreground text-background disabled:bg-muted-foreground",
														"transition-[background-color,scale] duration-100 enabled:hover:bg-foreground/85 active:scale-[0.96]",
													)}
													aria-label="调整当前回复"
													disabled={!onSteer}
													onClick={submit}
												>
													<ArrowUp className="size-4" />
												</Button>
											</TooltipTrigger>
											<TooltipContent>
												调整当前回复 ·{" "}
												{sendMessageShortcut === "enter"
													? "Enter"
													: "Ctrl/⌘ Enter"}
											</TooltipContent>
										</Tooltip>
									</>
								) : null}
							</>
						) : (
							<Tooltip>
								<TooltipTrigger asChild>
									<Button
										type="button"
										size="icon"
										className={cn(
											"size-7 rounded-full bg-foreground text-background disabled:bg-muted-foreground",
											"transition-[background-color,scale] duration-100 enabled:hover:bg-foreground/85 active:scale-[0.96]",
										)}
										aria-label="发送"
										disabled={!value.trim() || disabled}
										onClick={submit}
									>
										<ArrowUp className="size-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									发送 ·{" "}
									{sendMessageShortcut === "enter" ? "Enter" : "Ctrl/⌘ Enter"}
								</TooltipContent>
							</Tooltip>
						)}
					</div>
				</div>
			</div>
		</div>
	);
}
