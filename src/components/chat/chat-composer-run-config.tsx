import { Bot, Check, LoaderCircle } from "lucide-react";

import { CHAT_COMPOSER_RUN_CONFIG_TRIGGER_CLASS_NAME } from "@/components/chat/chat-composer-frame";
import type { PiModel, PiThinkingLevel } from "@/lib/pi-runtime";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/ui";

const DEFAULT_MODEL_VALUE = "__pilo_default_model__";
const DEFAULT_THINKING_VALUE = "__pilo_default_thinking__";

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

type ComposerRunConfigProps = {
	modelLabel: string;
	models: readonly PiModel[];
	selectedModel: PiModel | null;
	modelLoading: boolean;
	modelError: string | null;
	modelDisabled: boolean;
	showDefaultModelOption: boolean;
	onModelMenuOpen?: () => void;
	onModelChange?: (model: PiModel | null) => void;
	thinkingLevels: readonly PiThinkingLevel[];
	selectedThinkingLevel: PiThinkingLevel | null;
	thinkingLoading: boolean;
	thinkingDisabled: boolean;
	showDefaultThinkingOption: boolean;
	onThinkingMenuOpen?: () => void;
	onThinkingChange?: (level: PiThinkingLevel | null) => void;
};

export function ComposerRunConfig({
	modelLabel,
	models,
	selectedModel,
	modelLoading,
	modelError,
	modelDisabled,
	showDefaultModelOption,
	onModelMenuOpen,
	onModelChange,
	thinkingLevels,
	selectedThinkingLevel,
	thinkingLoading,
	thinkingDisabled,
	showDefaultThinkingOption,
	onThinkingMenuOpen,
	onThinkingChange,
}: ComposerRunConfigProps) {
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
	const disabled =
		(modelDisabled || !onModelChange) &&
		(thinkingDisabled || !onThinkingChange);

	return (
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
					disabled={disabled}
					aria-label="运行配置"
					className={CHAT_COMPOSER_RUN_CONFIG_TRIGGER_CLASS_NAME}
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
								<span className="min-w-0 flex-1 truncate">{modelError}</span>
								<span className="text-xs text-muted-foreground">重试</span>
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
							<DropdownMenuItem disabled>正在读取推理等级…</DropdownMenuItem>
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
	);
}
