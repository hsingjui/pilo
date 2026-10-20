import {
	type ComponentPropsWithoutRef,
	lazy,
	Suspense,
	useEffect,
	useState,
} from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CHAT_COMPOSER_RUN_CONFIG_TRIGGER_CLASS_NAME } from "@/components/chat/chat-composer-frame";
import { PiLogo } from "@/components/pi-logo";
import type { PiModel, PiThinkingLevel } from "@/lib/api/pi-runtime";
import type { ModelScopeControls } from "@/lib/project-model-scope";
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
	Spinner,
} from "@/ui";

const ChatModelPicker = lazy(() =>
	import("@/components/chat/chat-model-picker").then((module) => ({
		default: module.ChatModelPicker,
	})),
);

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
	modelScope?: ModelScopeControls;
	canEditScope?: boolean;
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
	const { t } = useTranslation();
	const isTouch = useIsTouchDevice();
	const [open, setOpen] = useState(false);
	const [modelOpen, setModelOpen] = useState(false);
	const label =
		props.selectedModel?.name ||
		props.selectedModel?.id ||
		(props.modelLoading ? t("chat.loadingModels") : "—");
	const thinking = thinkingLevelLabel(props.selectedThinkingLevel);
	// Membership editing is independent of the active Pi process and remains usable during streaming.
	const disabled =
		(props.modelDisabled || !props.onModelChange) &&
		(props.thinkingDisabled || !props.onThinkingChange) &&
		!props.canEditScope;
	const changeOpen = (next: boolean) => {
		if (!next && props.modelScope?.saving) return;
		setOpen(next);
		if (next) {
			props.onModelMenuOpen?.();
			props.onThinkingMenuOpen?.();
			void props.modelScope?.refresh();
		}
	};
	const trigger = (
		<RunConfigTrigger label={label} thinking={thinking} disabled={disabled} />
	);
	const panel = (
		<RunConfigPanel
			key={`${props.modelScope?.projectId ?? ""}:${props.canEditScope}`}
			{...props}
		/>
	);

	if (!isTouch)
		return (
			<DropdownMenu open={open} onOpenChange={changeOpen}>
				<DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
				<DropdownMenuContent
					side="top"
					align="start"
					sideOffset={8}
					collisionPadding={16}
					className="min-w-56"
				>
					<DropdownMenuSub
						open={modelOpen}
						onOpenChange={(next) => {
							if (!next && props.modelScope?.saving) return;
							setModelOpen(next);
						}}
					>
						<DropdownMenuSubTrigger
							className="pr-1.5"
							aria-haspopup="dialog"
							disabled={
								(props.modelDisabled || !props.onModelChange) &&
								!props.canEditScope
							}
						>
							<span className="min-w-0 flex-1 truncate">{t("chat.model")}</span>
							<span className="ml-4 max-w-40 truncate text-xs text-muted-foreground">
								{props.modelLoading ? t("chat.loadingModels") : label}
							</span>
						</DropdownMenuSubTrigger>
						{/* oxlint-disable jsx-a11y/prefer-tag-over-role -- 该面板含搜索输入框，需要 dialog 语义；Radix popper 定位的弹出层不能用原生 <dialog> 元素。 */}
						<DropdownMenuSubContent
							align="end"
							alignOffset={-24}
							collisionPadding={16}
							role="dialog"
							aria-label={t("chat.model")}
							className="w-76 max-w-[calc(100vw-2rem)] p-0"
							onFocus={(event) => {
								if (event.target === event.currentTarget)
									event.currentTarget.querySelector("input")?.focus();
							}}
							onEscapeKeyDown={(event) => {
								if (props.modelScope?.saving) event.preventDefault();
							}}
							onFocusOutside={(event) => {
								if (props.modelScope?.saving) event.preventDefault();
							}}
						>
							<div
								role="presentation"
								onKeyDown={(event) => {
									// The picker owns typing/arrows; Radix menu typeahead must not intercept them.
									if (event.key === "Escape") return;
									event.stopPropagation();
									if (event.key !== "Tab") return;
									const controls = Array.from(
										event.currentTarget.querySelectorAll<HTMLElement>(
											'input:not(:disabled), button:not(:disabled), [tabindex="0"]',
										),
									).filter(
										(element) =>
											element.tabIndex >= 0 &&
											element.getClientRects().length > 0,
									);
									const index = controls.findIndex(
										(element) => element === document.activeElement,
									);
									const next = event.shiftKey ? index - 1 : index + 1;
									if (next < 0 || next >= controls.length) {
										event.preventDefault();
										controls[event.shiftKey ? controls.length - 1 : 0]?.focus();
									}
								}}
							>
								{open && modelOpen ? (
									<RunConfigModelPicker
										key={`${props.modelScope?.projectId ?? ""}:${props.canEditScope}`}
										{...props}
										compact
									/>
								) : null}
							</div>
						</DropdownMenuSubContent>
						{/* oxlint-enable jsx-a11y/prefer-tag-over-role */}
					</DropdownMenuSub>
					<DropdownMenuSub>
						<DropdownMenuSubTrigger
							className="pr-1.5"
							disabled={
								props.thinkingDisabled ||
								!props.onThinkingChange ||
								props.modelScope?.saving
							}
						>
							<span className="min-w-0 flex-1 truncate">
								{t("chat.reasoning")}
							</span>
							<span className="ml-4 max-w-40 truncate text-xs text-muted-foreground">
								{props.thinkingLoading ? t("chat.loadingModels") : thinking}
							</span>
						</DropdownMenuSubTrigger>
						<DropdownMenuSubContent
							align="end"
							alignOffset={-24}
							collisionPadding={16}
							className="min-w-40"
						>
							{props.thinkingLoading ? (
								<DropdownMenuItem disabled>
									{t("chat.readingReasoning")}
								</DropdownMenuItem>
							) : props.thinkingLevels.length === 0 ? (
								<DropdownMenuItem disabled>
									{t("chat.noReasoning")}
								</DropdownMenuItem>
							) : (
								props.thinkingLevels.map((level) => (
									<DropdownMenuItem
										key={level}
										className="justify-between"
										onSelect={(event) => {
											event.preventDefault();
											props.onThinkingChange?.(level);
										}}
									>
										<span>{thinkingLevelLabel(level)}</span>
										{props.selectedThinkingLevel === level ? (
											<Check className="size-3.5 opacity-70" />
										) : null}
									</DropdownMenuItem>
								))
							)}
						</DropdownMenuSubContent>
					</DropdownMenuSub>
				</DropdownMenuContent>
			</DropdownMenu>
		);

	return (
		<DialogPrimitive.Root open={open} onOpenChange={changeOpen}>
			<DialogPrimitive.Trigger asChild>{trigger}</DialogPrimitive.Trigger>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-dialog-overlay)] bg-black/40" />
				<DialogPrimitive.Content
					className={cn(
						"fixed inset-x-0 bottom-[var(--remote-keyboard-bottom,0px)] z-[var(--z-dialog)] mx-auto max-h-[calc(var(--remote-viewport-height,100dvh)*0.85)] w-full max-w-lg overflow-y-auto overscroll-contain rounded-t-(--pilo-sheet-radius) border-t border-border/70 bg-popover pb-[max(0.75rem,env(safe-area-inset-bottom))] text-popover-foreground shadow-(--pilo-shadow-floating)",
						"motion-safe:duration-200 motion-safe:data-[state=open]:animate-in motion-safe:data-[state=open]:slide-in-from-bottom motion-safe:data-[state=closed]:animate-out motion-safe:data-[state=closed]:slide-out-to-bottom",
					)}
				>
					<DialogPrimitive.Title className="sr-only">
						{t("chat.runConfigLabel", { model: label, thinking })}
					</DialogPrimitive.Title>
					<DialogPrimitive.Description className="sr-only">
						{t("chat.model")} · {t("chat.reasoning")}
					</DialogPrimitive.Description>
					<div className="flex items-center justify-between ps-4 pe-2 pt-2">
						<span className="text-sm font-medium">{t("chat.model")}</span>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="size-[max(44px,var(--pilo-sheet-control-height))] rounded-full text-muted-foreground"
							aria-label={t("common.close")}
							disabled={props.modelScope?.saving}
							onClick={() => changeOpen(false)}
						>
							<X className="size-4" aria-hidden="true" />
						</Button>
					</div>
					{panel}
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
}

type RunConfigTriggerProps = {
	label: string;
	thinking: string;
} & Omit<ComponentPropsWithoutRef<"button">, "children" | "className" | "type">;

function RunConfigTrigger({
	label,
	thinking,
	...buttonProps
}: RunConfigTriggerProps) {
	const { t } = useTranslation();
	return (
		<button
			{...buttonProps}
			data-chat-run-config-trigger=""
			type="button"
			aria-label={t("chat.runConfigLabel", { model: label, thinking })}
			className={cn(
				CHAT_COMPOSER_RUN_CONFIG_TRIGGER_CLASS_NAME,
				"-ms-1 max-w-fit grow gap-1 @max-[24rem]/toolbar:gap-0.5 @max-[24rem]/toolbar:[--pilo-ui-composer-run-config-padding:0]",
			)}
		>
			<PiLogo className="size-4 shrink-0 text-current" />
			<span
				data-chat-run-config-label=""
				// 窄屏只省略过长的模型名，Pi Logo 和思考等级始终保留。
				className="block min-w-0 flex-1 truncate text-left"
			>
				{label}
			</span>
			<span aria-hidden="true" className="shrink-0 text-muted-foreground/60">
				·
			</span>
			<span className="shrink-0">{thinking}</span>
		</button>
	);
}

function RunConfigModelPicker(
	props: ComposerRunConfigProps & { compact?: boolean },
) {
	const { t } = useTranslation();
	return (
		<Suspense
			fallback={
				<output className="flex min-h-28 items-center justify-center gap-2 p-3 text-sm text-muted-foreground">
					<Spinner className="size-4" aria-hidden="true" />
					{t("chat.loadingModels")}
				</output>
			}
		>
			<ChatModelPicker
				models={props.models}
				selectedModel={props.selectedModel}
				loading={props.modelLoading}
				error={props.modelError}
				disabled={props.modelDisabled}
				onRefresh={props.onModelRefresh}
				onChange={props.onModelChange}
				modelScope={props.modelScope}
				canEditScope={props.canEditScope ?? false}
				compact={props.compact}
			/>
		</Suspense>
	);
}

function RunConfigPanel(props: ComposerRunConfigProps) {
	const { t } = useTranslation();
	return (
		<>
			<RunConfigModelPicker {...props} />
			<div className="@container border-t border-border/60 px-3 pt-3 pb-1">
				<div className="mb-2 flex items-center gap-2 text-sm font-medium text-muted-foreground">
					{t("chat.reasoning")}
					{props.thinkingLoading ? <Spinner className="size-3.5" /> : null}
				</div>
				<div className="grid grid-cols-2 gap-1 @min-[17rem]:grid-cols-4">
					{props.thinkingLevels.map((level) => (
						<Button
							key={level}
							type="button"
							size="sm"
							variant={
								props.selectedThinkingLevel === level ? "secondary" : "ghost"
							}
							className="min-h-[max(44px,var(--pilo-sheet-control-height))] rounded-(--pilo-sheet-item-radius) px-2 font-normal shadow-none"
							disabled={props.thinkingDisabled || !props.onThinkingChange}
							aria-pressed={props.selectedThinkingLevel === level}
							onClick={() => props.onThinkingChange?.(level)}
						>
							{thinkingLevelLabel(level)}
						</Button>
					))}
					{props.thinkingLevels.length === 0 ? (
						<p className="col-span-full py-2 text-sm text-muted-foreground">
							{props.thinkingLoading
								? t("chat.readingReasoning")
								: t("chat.noReasoning")}
						</p>
					) : null}
				</div>
			</div>
		</>
	);
}
