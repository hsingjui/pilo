import {
	computed,
	effect,
	type JSX,
	keyboardFrame,
	platform,
	Scroll,
	signal,
	Text,
	token,
	untracked,
	View,
	windowSize,
} from "nsh";
import { Popover as BasePopover, Toggle, ToggleGroup } from "nsh/base";

import type { ComposerSendMode } from "@shared/chat/send-mode";

import { t } from "../shell/i18n";
import { chatPx } from "../chat/layout";
import { Button } from "../ui/button";
import { classNames } from "../ui/class-names";
import { Icon, type IconName } from "../ui/icon";
import { Menu, menuPopupStyle } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { MenuSeparator } from "../ui/menu-separator";
import { springTransition } from "../ui/motion";
import { Tooltip } from "../ui/tooltip";
import {
	composerActionsGap,
	composerSendModeStyle,
	composerSendSize,
} from "./composer-layout";

const SEND_MODE_OPTIONS = [
	{
		mode: "steer",
		icon: "CornerDownRight",
		label: "chat.sendModeSteer",
		detail: "chat.sendModeSteerDetail",
	},
	{
		mode: "follow_up",
		icon: "ListPlus",
		label: "chat.sendModeFollowUp",
		detail: "chat.sendModeFollowUpDetail",
	},
	{
		mode: "send_now",
		icon: "Zap",
		label: "chat.sendModeNow",
		detail: "chat.sendModeNowDetail",
	},
] as const satisfies readonly {
	mode: ComposerSendMode;
	icon: IconName;
	label: string;
	detail: string;
}[];

/**
 * The composer toolbar's right end, as the React `ComposerActions`: how a
 * message sent during a turn goes (steer, queue, interrupt), then the round
 * send button, which stops the turn while the draft is empty and stops a
 * send that is still on its way.
 */
export function ComposerActions(props: {
	toolbarWidth: () => number;
	beforeSendMode?: () => JSX.Element;
	sendMode: () => ComposerSendMode;
	onSendModeChange: (mode: ComposerSendMode) => void;
	running: () => boolean;
	/** The draft has text or attachments. */
	hasContent: () => boolean;
	/** A send is in flight or the chat cannot take one now. */
	blocked: () => boolean;
	sending: () => boolean;
	sendShortcut: () => "enter" | "mod-enter";
	/** Uses 40-44px touch-friendly hit targets for mobile / WebUI. */
	touch?: boolean;
	/** Visible height when the host already accounts for the keyboard. */
	availableHeight?: () => number;
	onSend: () => void;
	onStop: () => void;
}) {
	const option = () =>
		SEND_MODE_OPTIONS.find((entry) => entry.mode === props.sendMode()) ??
		SEND_MODE_OPTIONS[0];
	const modeLabel = () =>
		t("chat.sendModeCurrent", { mode: t(option().label) });
	const showSendMode = computed(() => props.running());
	const isBlocked = computed(() => props.blocked());
	const isInterruptMode = () =>
		showSendMode() && props.sendMode() === "send_now";
	const primaryIsStop = () =>
		props.sending() || (showSendMode() && !props.hasContent());
	const showDedicatedStop = computed(
		() => showSendMode() && !props.sending() && props.hasContent(),
	);
	const actionLabel = () =>
		primaryIsStop()
			? t("chat.stop")
			: showSendMode()
				? t(option().label)
				: t("chat.send");
	const shortcutHint = () =>
		props.sendShortcut() === "enter" ? " · Enter" : " · Ctrl/⌘ Enter";
	const sendModeStyle = () =>
		props.touch
			? {
					height: 40,
					minWidth: 40,
					gap: 4,
					paddingHorizontal: 8,
					paddingVertical: 0,
				}
			: composerSendModeStyle();
	const sendButtonSize = () =>
		props.touch ? { width: 32, height: 32 } : composerSendSize();
	const dedicatedStopButton = () => (
		<Button
			testID="chat-composer-stop"
			variant="outline"
			size="icon"
			class="rounded-full border-border/80 bg-muted hover:border-destructive/40 hover:bg-destructive/10"
			style={sendButtonSize()}
			accessibilityLabel={t("chat.stop")}
			tooltip={
				props.touch ? undefined : (
					<Tooltip>
						<Text class="font-sans">{() => t("chat.stop")}</Text>
					</Tooltip>
				)
			}
			onPress={props.onStop}
		>
			<Icon
				name="Square"
				size={props.touch ? 11 : chatPx(11)}
				fill
				color={token("foreground")}
			/>
		</Button>
	);
	const sendButtonAppearance = () => {
		if (!primaryIsStop() && isInterruptMode())
			return "bg-destructive hover:bg-destructive/90";
		if (!props.touch) return "bg-foreground hover:bg-foreground/85";
		return primaryIsStop()
			? "bg-muted hover:bg-hover"
			: "bg-primary hover:bg-button-hover";
	};
	const sendButton = (
		<Button
			testID="chat-composer-send"
			variant="ghost"
			size="icon"
			class={classNames(
				"rounded-full disabled:bg-muted-foreground disabled:opacity-100",
				sendButtonAppearance(),
			)}
			style={sendButtonSize()}
			accessibilityLabel={actionLabel()}
			disabled={
				primaryIsStop() ? false : !props.hasContent() || props.blocked()
			}
			tooltip={
				props.touch ? undefined : (
					<Tooltip>
						<Text class="font-sans">
							{() => actionLabel() + (primaryIsStop() ? "" : shortcutHint())}
						</Text>
					</Tooltip>
				)
			}
			onPress={() => (primaryIsStop() ? props.onStop() : props.onSend())}
		>
			<View class="relative size-4 items-center justify-center">
				<View
					class="absolute inset-0 items-center justify-center"
					style={[
						springTransition("opacity, transform", "crisp"),
						primaryIsStop()
							? { opacity: 1, transform: [{ scale: 1 }] }
							: { opacity: 0, transform: [{ scale: 0.65 }] },
					]}
				>
					<Icon
						name="Square"
						size={props.touch ? 12 : chatPx(12)}
						fill
						color={token(props.touch ? "foreground" : "background")}
					/>
				</View>
				<View
					class="absolute inset-0 items-center justify-center"
					style={[
						springTransition("opacity, transform", "crisp"),
						primaryIsStop()
							? { opacity: 0, transform: [{ scale: 0.65 }] }
							: { opacity: 1, transform: [{ scale: 1 }] },
					]}
				>
					{() =>
						isInterruptMode() ? (
							<Icon
								name="Zap"
								size={props.touch ? 15 : chatPx(15)}
								color={token("destructive-foreground")}
							/>
						) : (
							<Icon
								name="ArrowUp"
								size={props.touch ? 16 : chatPx(16)}
								color={token(props.touch ? "primary-foreground" : "background")}
							/>
						)
					}
				</View>
			</View>
		</Button>
	);
	const touch = Boolean(props.touch);
	const useAnchoredPopover = touch && !platform.desktop;
	const touchMenuOpen = signal(false);
	if (useAnchoredPopover) {
		effect(() => {
			if (isBlocked() || !showSendMode()) touchMenuOpen.set(false);
		});
	}
	const sendModeIconColor = () =>
		token(
			option().mode === "send_now"
				? "destructive"
				: touch
					? "foreground"
					: "muted-foreground",
		);
	const sendModeTrigger = () => (
		<Button
			testID="chat-composer-send-mode"
			variant="ghost"
			size="sm"
			class={touch ? "rounded-(--pilo-mobile-radius-md)" : undefined}
			style={sendModeStyle()}
			disabled={props.blocked()}
			accessibilityLabel={modeLabel()}
			tooltip={
				touch ? undefined : (
					<Tooltip>
						<Text class="font-sans">{modeLabel}</Text>
					</Tooltip>
				)
			}
		>
			{() => (
				<Icon
					name={option().icon}
					size={touch ? 15 : chatPx(14)}
					color={sendModeIconColor()}
				/>
			)}
			<Icon
				name="ChevronDown"
				size={touch ? 13 : chatPx(12)}
				color={sendModeIconColor()}
			/>
		</Button>
	);
	// On phone/compact idioms `nsh/base`'s `Menu` turns into an unstyled bottom
	// sheet anchored at the bottom-left. Anchor a Popover directly above the
	// trigger instead (same pattern as `web/mobile-dropdown-menu.tsx`).
	const sendModePicker = () =>
		useAnchoredPopover ? (
			<BasePopover
				open={touchMenuOpen()}
				onOpenChange={({ open }) => {
					if (open && props.blocked()) return;
					touchMenuOpen.set(open);
				}}
				placement="top"
				align="end"
				offset={8}
				margin={8}
				popupClass="overflow-hidden rounded-(--pilo-mobile-menu-radius) bg-(--pilo-menu-background) p-(--pilo-mobile-menu-padding) font-sans text-foreground"
				popupStyle={[
					menuPopupStyle(),
					{ width: Math.min(240, Math.max(204, windowSize().width - 16)) },
				]}
				trigger={sendModeTrigger()}
			>
				<Scroll
					bounces={false}
					style={{
						maxHeight: Math.max(
							160,
							Math.round(
								(props.availableHeight?.() ??
									windowSize().height - keyboardFrame().height) * 0.55,
							),
						),
					}}
				>
					<View testID="chat-composer-send-mode-popup" class="w-full">
						<Text class="px-2.5 pt-1.5 pb-1 font-sans text-xs text-(length:--pilo-ui-text-2xs) leading-tight font-semibold uppercase tracking-[0.6px] text-muted-foreground">
							{() => t("chat.sendMode")}
						</Text>
						<ToggleGroup class="gap-0.5">
							{SEND_MODE_OPTIONS.map((entry) => {
								const active = () => props.sendMode() === entry.mode;
								const destructive = entry.mode === "send_now";
								return (
									<>
										{destructive ? (
											<View class="my-0.5 h-px bg-(--pilo-menu-edge)" />
										) : null}
										<Toggle
											testID={`chat-composer-send-mode:${entry.mode}`}
											pressed={active()}
											accessibilityLabel={t(entry.label)}
											class={classNames(
												"min-h-11 w-full flex-row items-center gap-2.5 rounded-(--pilo-mobile-menu-item-radius) px-2.5 py-1.5 text-left",
												destructive
													? "hover:bg-destructive/10 active:bg-destructive/10"
													: "hover:bg-hover active:bg-hover",
												active() &&
													(destructive ? "bg-destructive/10" : "bg-muted/70"),
											)}
											onChange={() => {
												props.onSendModeChange(entry.mode);
												touchMenuOpen.set(false);
											}}
										>
											<Icon
												name={entry.icon}
												size={16}
												color={token(
													destructive
														? "destructive"
														: active()
															? "foreground"
															: "muted-foreground",
												)}
											/>
											<View class="min-w-0 flex-1 gap-0.5">
												<Text
													class={classNames(
														"font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight",
														destructive
															? "font-medium text-destructive"
															: active()
																? "font-semibold text-foreground"
																: "font-medium text-foreground",
													)}
												>
													{() => t(entry.label)}
												</Text>
												<Text class="font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-muted-foreground">
													{() => t(entry.detail)}
												</Text>
											</View>
											<View class="size-4 shrink-0 items-center justify-center">
												{() =>
													active() ? (
														<Icon
															name="Check"
															size={15}
															color={token(
																destructive ? "destructive" : "primary",
															)}
														/>
													) : null
												}
											</View>
										</Toggle>
									</>
								);
							})}
						</ToggleGroup>
					</View>
				</Scroll>
			</BasePopover>
		) : (
			<Menu
				placement="top"
				align="end"
				offset={8}
				popupStyle={{ minWidth: 184, maxWidth: 232 }}
				trigger={sendModeTrigger()}
			>
				<Text class="px-2.5 pt-1.5 pb-1 font-sans text-[11px] font-semibold uppercase leading-tight tracking-[0.6px] text-muted-foreground">
					{() => t("chat.sendMode")}
				</Text>
				<View class="gap-0.5">
					{SEND_MODE_OPTIONS.map((entry) => {
						const destructive = entry.mode === "send_now";
						return (
							<>
								{destructive ? <MenuSeparator /> : null}
								<MenuItem
									testID={`chat-composer-send-mode:${entry.mode}`}
									role="menuitemradio"
									variant={destructive ? "destructive" : undefined}
									checked={props.sendMode() === entry.mode}
									accessibilityLabel={t(entry.label)}
									class="gap-2.5 px-2.5 py-1.5"
									icon={<Icon name={entry.icon} size={14} />}
									onSelect={() => props.onSendModeChange(entry.mode)}
								>
									<View class="min-w-0 flex-1 gap-0.5">
										<Text
											class={classNames(
												"font-sans text-sm text-(length:--pilo-ui-text-sm) font-medium leading-tight",
												destructive && "text-destructive",
											)}
										>
											{() => t(entry.label)}
										</Text>
										<Text class="font-sans text-xs text-(length:--pilo-ui-text-xs) leading-tight text-muted-foreground">
											{() => t(entry.detail)}
										</Text>
									</View>
								</MenuItem>
							</>
						);
					})}
				</View>
			</Menu>
		);
	return (
		<View
			testID="chat-composer-actions"
			class="ml-auto shrink-0 flex-row items-center"
			style={{ gap: composerActionsGap(props.toolbarWidth()) }}
		>
			{props.beforeSendMode}
			{() => (showSendMode() ? untracked(sendModePicker) : null)}
			{touch ? (
				<>
					{() =>
						showDedicatedStop() ? (
							<View class="size-10 shrink-0 items-center justify-center">
								{untracked(dedicatedStopButton)}
							</View>
						) : null
					}
					<View class="size-10 shrink-0 items-center justify-center">
						{sendButton}
					</View>
				</>
			) : (
				<>
					{() => (showDedicatedStop() ? untracked(dedicatedStopButton) : null)}
					{sendButton}
				</>
			)}
		</View>
	);
}
