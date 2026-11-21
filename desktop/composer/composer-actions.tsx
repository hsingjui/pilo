import { Text, token, View } from "nsh";

import type { ComposerSendMode } from "@shared/chat/send-mode";

import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Icon, type IconName } from "../ui/icon";
import { Menu } from "../ui/menu";
import { MenuItem } from "../ui/menu-item";
import { Tooltip } from "../ui/tooltip";

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
	sendMode: () => ComposerSendMode;
	onSendModeChange: (mode: ComposerSendMode) => void;
	running: () => boolean;
	/** The draft has text or attachments. */
	hasContent: () => boolean;
	/** A send is in flight or the chat cannot take one now. */
	blocked: () => boolean;
	sending: () => boolean;
	sendShortcut: () => "enter" | "mod-enter";
	onSend: () => void;
	onStop: () => void;
}) {
	const option = () =>
		SEND_MODE_OPTIONS.find((entry) => entry.mode === props.sendMode()) ??
		SEND_MODE_OPTIONS[0];
	const modeLabel = () =>
		t("chat.sendModeCurrent", { mode: t(option().label) });
	const showStop = () =>
		props.sending() || (props.running() && !props.hasContent());
	const actionLabel = () =>
		showStop()
			? t("chat.stop")
			: props.running()
				? t(option().label)
				: t("chat.send");
	const shortcutHint = () =>
		props.sendShortcut() === "enter" ? " · Enter" : " · Ctrl/⌘ Enter";
	return (
		<View
			testID="chat-composer-actions"
			class="ml-auto shrink-0 flex-row items-center gap-1.5"
		>
			<Menu
				placement="top"
				align="end"
				offset={8}
				popupStyle={{ minWidth: 0 }}
				trigger={
					<Button
						testID="chat-composer-send-mode"
						variant="ghost"
						class="h-(--pilo-composer-control-size) gap-1 rounded-(--pilo-radius-md) px-1.5"
						disabled={props.blocked()}
						accessibilityLabel={modeLabel()}
						tooltip={
							<Tooltip>
								<Text class="font-sans">{modeLabel}</Text>
							</Tooltip>
						}
					>
						{() => (
							<Icon
								name={option().icon}
								size={14}
								color={token("muted-foreground")}
							/>
						)}
						<Icon
							name="ChevronDown"
							size={12}
							color={token("muted-foreground")}
						/>
					</Button>
				}
			>
				<Text class="px-3 pt-2 pb-1 font-sans text-[11px] font-semibold uppercase leading-tight tracking-[0.6px] text-muted-foreground">
					{() => t("chat.sendMode")}
				</Text>
				<View class="gap-1">
					{SEND_MODE_OPTIONS.map((entry) => (
						<MenuItem
							testID={`chat-composer-send-mode:${entry.mode}`}
							role="menuitemradio"
							checked={props.sendMode() === entry.mode}
							accessibilityLabel={t(entry.label)}
							class="py-1"
							icon={<Icon name={entry.icon} size={14} />}
							onSelect={() => props.onSendModeChange(entry.mode)}
						>
							<View class="min-w-0 flex-1">
								<Text class="font-sans text-sm font-medium">
									{() => t(entry.label)}
								</Text>
								<Text class="font-sans text-xs leading-tight text-muted-foreground">
									{() => t(entry.detail)}
								</Text>
							</View>
						</MenuItem>
					))}
				</View>
			</Menu>
			<Button
				testID="chat-composer-send"
				variant="ghost"
				size="icon"
				class="size-(--pilo-composer-control-size) rounded-full bg-foreground hover:bg-foreground/85 disabled:bg-muted-foreground disabled:opacity-100"
				accessibilityLabel={actionLabel()}
				disabled={showStop() ? false : !props.hasContent() || props.blocked()}
				tooltip={
					<Tooltip>
						<Text class="font-sans">
							{() => actionLabel() + (showStop() ? "" : shortcutHint())}
						</Text>
					</Tooltip>
				}
				onPress={() => (showStop() ? props.onStop() : props.onSend())}
			>
				{() =>
					showStop() ? (
						<Icon name="Square" size={12} fill color={token("background")} />
					) : (
						<Icon name="ArrowUp" size={16} color={token("background")} />
					)
				}
			</Button>
		</View>
	);
}
