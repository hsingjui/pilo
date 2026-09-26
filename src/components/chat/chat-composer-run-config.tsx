import { useEffect, useState } from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Check, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CHAT_COMPOSER_RUN_CONFIG_TRIGGER_CLASS_NAME } from "@/components/chat/chat-composer-frame";
import { PiLogo } from "@/components/pi-logo";
import type { PiModel, PiThinkingLevel } from "@/lib/pi-runtime";
import { cn } from "@/lib/utils";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuSub,
	DropdownMenuSubContent,
	DropdownMenuSubTrigger,
	DropdownMenuTrigger,
	Spinner,
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

// 触屏（无 hover、粗指针）走底部抽屉，桌面鼠标走嵌套下拉，两者都内联在底栏。
// ponytail: matchMedia 探测而非 prop 透传，ChatComposer 调用方零改动。
export function useIsTouchDevice() {
	const [touch, setTouch] = useState(
		() =>
			typeof window !== "undefined" &&
			window.matchMedia("(hover: none) and (pointer: coarse)").matches,
	);
	useEffect(() => {
		const media = window.matchMedia("(hover: none) and (pointer: coarse)");
		const onChange = () => setTouch(media.matches);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, []);
	return touch;
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

export function ComposerRunConfig(props: ComposerRunConfigProps) {
	const isTouch = useIsTouchDevice();
	return isTouch ? (
		<TouchRunConfigSheet {...props} />
	) : (
		<DesktopRunConfigMenu {...props} />
	);
}

function RunConfigTrigger({
	label,
	thinking,
	disabled,
	loading,
	ariaHasPopup,
	ariaExpanded,
	onClick,
}: {
	label: string;
	thinking: string;
	disabled: boolean;
	loading?: boolean;
	ariaHasPopup?: "dialog";
	ariaExpanded?: boolean;
	onClick?: () => void;
}) {
	const { t } = useTranslation();
	return (
		<button
			data-chat-run-config-trigger=""
			type="button"
			disabled={disabled}
			aria-label={t("chat.runConfigLabel", {
				model: label,
				thinking,
			})}
			aria-haspopup={ariaHasPopup}
			aria-expanded={ariaExpanded}
			className={CHAT_COMPOSER_RUN_CONFIG_TRIGGER_CLASS_NAME}
			onClick={onClick}
		>
			<PiLogo className="size-4 text-current" />
			{loading ? <Spinner className="size-3.5 shrink-0" /> : null}
			<span className="block min-w-0 max-w-40 truncate text-left">{label}</span>
			<span aria-hidden="true" className="shrink-0 text-muted-foreground/60">
				·
			</span>
			<span className="shrink-0">{thinking}</span>
		</button>
	);
}

// ---- 桌面：原有嵌套下拉（与既有实现一致） ------------------------------

function DesktopRunConfigMenu({
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
	const { t } = useTranslation();
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
				<RunConfigTrigger
					label={effectiveModelLabel}
					thinking={effectiveThinkingLabel}
					disabled={disabled}
				/>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" className="min-w-56">
				<DropdownMenuSub>
					<DropdownMenuSubTrigger
						className="pr-1.5"
						disabled={modelDisabled || !onModelChange}
					>
						<span className="min-w-0 flex-1 truncate">{t("chat.model")}</span>
						<span className="ml-4 max-w-40 truncate text-xs text-muted-foreground">
							{modelLoading ? t("chat.loadingModels") : effectiveModelLabel}
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
								<Spinner className="size-3.5" />
							) : (
								<RefreshCw className="size-3.5" />
							)}
							{t("chat.refreshModels")}
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
									{modelLoading ? t("chat.readingModels") : t("chat.noModels")}
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
						<span className="min-w-0 flex-1 truncate">
							{t("chat.reasoning")}
						</span>
						<span className="ml-4 max-w-40 truncate text-xs text-muted-foreground">
							{thinkingLoading
								? t("chat.loadingModels")
								: effectiveThinkingLabel}
						</span>
					</DropdownMenuSubTrigger>
					<DropdownMenuSubContent className="min-w-40">
						{thinkingLoading ? (
							<DropdownMenuItem disabled>
								{t("chat.readingReasoning")}
							</DropdownMenuItem>
						) : thinkingLevels.length === 0 ? (
							<DropdownMenuItem disabled>
								{t("chat.noReasoning")}
							</DropdownMenuItem>
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

// ---- 触屏：底部抽屉，选完保持打开，点空白处关闭 ----------------------

function TouchRunConfigSheet({
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
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const effectiveModelLabel = selectedModel?.name || selectedModel?.id || "—";
	const effectiveThinkingLabel = thinkingLevelLabel(selectedThinkingLevel);
	const selectedModelValue = selectedModel ? modelValue(selectedModel) : "";
	const disabled =
		(modelDisabled || !onModelChange) &&
		(thinkingDisabled || !onThinkingChange);
	const modelSectionDisabled = modelDisabled || !onModelChange;
	const thinkingSectionDisabled = thinkingDisabled || !onThinkingChange;

	const openSheet = () => {
		setOpen(true);
		onModelMenuOpen?.();
		onThinkingMenuOpen?.();
	};

	return (
		<DialogPrimitive.Root open={open} onOpenChange={setOpen}>
			<RunConfigTrigger
				label={effectiveModelLabel}
				thinking={effectiveThinkingLabel}
				disabled={disabled}
				aria-label={t("chat.runConfigLabel", {
					model: effectiveModelLabel,
					thinking: effectiveThinkingLabel,
				})}
				onClick={openSheet}
			/>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-dialog-overlay)] bg-black/40 duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
				<DialogPrimitive.Content
					className={cn(
						"fixed inset-x-0 bottom-0 z-[var(--z-dialog)] mx-auto flex max-h-[85dvh] w-full max-w-lg flex-col rounded-t-2xl border-t border-border/70 bg-background pb-[max(0.75rem,env(safe-area-inset-bottom))] shadow-popover outline-none",
						"duration-200 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0",
						"motion-safe:data-[state=closed]:slide-out-to-bottom motion-safe:data-[state=open]:slide-in-from-bottom",
					)}
				>
					<DialogPrimitive.Title className="sr-only">
						{t("chat.runConfigLabel", {
							model: effectiveModelLabel,
							thinking: effectiveThinkingLabel,
						})}
					</DialogPrimitive.Title>
					<DialogPrimitive.Description className="sr-only">
						{t("chat.model")} · {t("chat.reasoning")}
					</DialogPrimitive.Description>

					{/* 拖拽提示条：点按关闭，符合底部抽屉惯例 */}
					<button
						type="button"
						aria-label={t("common.close")}
						className="flex w-full justify-center pt-2.5"
						onClick={() => setOpen(false)}
					>
						<span className="h-1 w-10 rounded-full bg-muted-foreground/30" />
					</button>

					{/* 模型 */}
					<div className="flex items-center gap-2 px-4 pb-1 pt-2">
						<span className="text-2xs font-semibold uppercase leading-tight tracking-[0.6px] text-muted-foreground">
							{t("chat.model")}
						</span>
						<span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
							{modelLoading ? t("chat.loadingModels") : effectiveModelLabel}
						</span>
						<button
							type="button"
							disabled={!onModelRefresh || modelLoading}
							aria-label={t("chat.refreshModels")}
							className="flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors active:bg-muted disabled:opacity-50"
							onClick={() => onModelRefresh?.()}
						>
							{modelLoading ? (
								<Spinner className="size-4" />
							) : (
								<RefreshCw className="size-4" />
							)}
						</button>
					</div>
					<div className="max-h-[40dvh] overflow-y-auto overscroll-contain px-2">
						{modelError ? (
							<p className="px-2 py-2 text-sm text-destructive">{modelError}</p>
						) : models.length === 0 ? (
							<p className="px-2 py-3 text-sm text-muted-foreground">
								{modelLoading ? t("chat.readingModels") : t("chat.noModels")}
							</p>
						) : (
							models.map((model) => {
								const optionValue = modelValue(model);
								return (
									<button
										key={optionValue}
										type="button"
										disabled={modelSectionDisabled}
										className={cn(
											"flex min-h-11 w-full items-center gap-2 rounded-lg px-2 text-start text-sm transition-colors active:bg-muted disabled:opacity-50",
											selectedModelValue === optionValue && "bg-muted",
										)}
										onClick={() => {
											onModelChange?.(model);
										}}
									>
										<span className="min-w-0 flex-1 truncate">
											{model.name || model.id}
										</span>
										<span className="shrink-0 text-xs text-muted-foreground">
											{model.provider}
										</span>
										{selectedModelValue === optionValue ? (
											<Check className="size-4 shrink-0 opacity-70" />
										) : null}
									</button>
								);
							})
						)}
					</div>

					{/* 推理 */}
					<div className="mt-2 border-t border-border/60 px-4 pb-1 pt-3">
						<div className="flex items-center gap-2">
							<span className="text-2xs font-semibold uppercase leading-tight tracking-[0.6px] text-muted-foreground">
								{t("chat.reasoning")}
							</span>
							{thinkingLoading ? (
								<span className="text-xs text-muted-foreground">
									{t("chat.loadingModels")}
								</span>
							) : null}
						</div>
					</div>
					{thinkingSectionDisabled && !thinkingLoading ? (
						<p className="px-4 pb-2 pt-1 text-sm text-muted-foreground">
							{t("chat.noReasoning")}
						</p>
					) : (
						<div className="flex flex-wrap gap-1.5 px-3 pb-1 pt-1.5">
							{thinkingLevels.map((level) => (
								<button
									key={level}
									type="button"
									disabled={thinkingSectionDisabled}
									aria-pressed={selectedThinkingLevel === level}
									className={cn(
										"min-h-9 rounded-full px-3.5 text-sm transition-colors active:scale-[0.97] disabled:opacity-50",
										selectedThinkingLevel === level
											? "bg-foreground text-background"
											: "bg-muted text-foreground",
									)}
									onClick={() => {
										onThinkingChange?.(level);
									}}
								>
									{thinkingLevelLabel(level)}
								</button>
							))}
							{thinkingLevels.length === 0 && !thinkingLoading ? (
								<p className="w-full px-1 py-2 text-sm text-muted-foreground">
									{t("chat.noReasoning")}
								</p>
							) : null}
						</div>
					)}
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}
