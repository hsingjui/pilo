import { Check, LoaderCircle, RefreshCw } from "lucide-react";

import { CHAT_COMPOSER_RUN_CONFIG_TRIGGER_CLASS_NAME } from "@/components/chat/chat-composer-frame";
import { PiLogo } from "@/components/pi-logo";
import type { PiModel, PiThinkingLevel } from "@/lib/pi-runtime";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
} from "@/ui";

const THINKING_LEVEL_LABELS: Record<PiThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "XHigh",
	max: "Max",
};

function thinkingLevelLabel(level: PiThinkingLevel | null) {
	return level ? THINKING_LEVEL_LABELS[level] : "—";
}

function modelValue(model: PiModel) {
	return JSON.stringify([model.provider, model.id]);
}

type ComposerRunConfigProps = {
	models: readonly PiModel[];
	selectedModel: PiModel | null;
	modelLoading: boolean;
	modelError: string | null;
	modelDisabled: boolean;
	onModelMenuOpen?: () => void;
	onModelRefresh?: () => void;
	onModelChange?: (model: PiModel | null) => void;
	thinkingLevels: readonly PiThinkingLevel[];
	selectedThinkingLevel: PiThinkingLevel | null;
	thinkingLoading: boolean;
	thinkingDisabled: boolean;
	onThinkingMenuOpen?: () => void;
	onThinkingChange?: (level: PiThinkingLevel | null) => void;
};

export function ComposerRunConfig({
	models,
	selectedModel,
	modelLoading,
	modelError,
	modelDisabled,
	onModelMenuOpen,
	onModelRefresh,
	onModelChange,
	thinkingLevels,
	selectedThinkingLevel,
	thinkingLoading,
	thinkingDisabled,
	onThinkingMenuOpen,
	onThinkingChange,
}: ComposerRunConfigProps) {
	const effectiveModelLabel = selectedModel?.name || selectedModel?.id || "—";
	const selectedModelValue = selectedModel ? modelValue(selectedModel) : "";
	const selectedThinkingValue = selectedThinkingLevel ?? "";
	const effectiveThinkingLabel = thinkingLevelLabel(selectedThinkingLevel);
	const renderModelItems = (items: readonly PiModel[]) =>
		items.map((model) => {
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
		});
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
					<PiLogo className="size-4 text-current" />
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
					<DropdownMenuSubContent className="w-72 max-w-[calc(100vw-2rem)] overflow-hidden">
						<DropdownMenuItem
							onSelect={(event) => {
								event.preventDefault();
								onModelRefresh?.();
							}}
							disabled={!onModelRefresh || modelLoading}
							className="gap-2"
						>
							{modelLoading ? (
								<LoaderCircle className="size-3.5 animate-spin" />
							) : (
								<RefreshCw className="size-3.5" />
							)}
							刷新模型
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<div className="max-h-[min(20rem,calc(70vh-3rem))] overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
							{modelError ? (
								<DropdownMenuItem disabled>
									<span className="min-w-0 flex-1 truncate text-destructive">
										{modelError}
									</span>
								</DropdownMenuItem>
							) : null}
							{models.length === 0 ? (
								<DropdownMenuItem disabled>
									{modelLoading ? "正在读取 Pi 模型…" : "没有可用模型"}
								</DropdownMenuItem>
							) : (
								renderModelItems(models)
							)}
						</div>
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
