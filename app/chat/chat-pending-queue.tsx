import {
	type Accessor,
	keyboardFrame,
	Scroll,
	Text,
	token,
	View,
	windowSize,
} from "nsh";

import type { ComposerStore } from "../composer/composer-store";
import { t } from "../shell/i18n";
import type { ChatQueueStore } from "../state/chat-queue-store";
import { Button } from "../ui/button";
import { classNames } from "../ui/class-names";
import { Icon } from "../ui/icon";
import { scrollbarLook } from "../ui/scrollbar";
import { textTooltip, Tooltip } from "../ui/tooltip";

/** Touch text scale aligned with Mobile WebUI's 16/14 typography ratio. */
const TOUCH_TEXT = {
	badge: { fontSize: 12.5, lineHeight: 16 },
	body: { fontSize: 13.75, lineHeight: 18 },
} as const;

export interface ChatPendingQueueProps {
	queue: ChatQueueStore;
	composer: ComposerStore;
	sessionKey: Accessor<string | null>;
	/** Extra disabled condition (e.g. disconnected Remote WebUI). */
	disabled?: Accessor<boolean>;
	/** Uses 40px touch targets, larger mobile text, and keyboard-aware height. */
	touch?: boolean;
	/** Visible height when the host already accounts for the keyboard. */
	availableHeight?: Accessor<number>;
}

/**
 * Pending `steer` / `follow_up` messages queued during an active turn, matching
 * the Tauri NoticeCard layout with retrieve-to-edit and interrupt-and-send-now.
 */
export function ChatPendingQueue(props: ChatPendingQueueProps) {
	const items = () => props.queue.items(props.sessionKey());
	const actionsDisabled = () => {
		const key = props.sessionKey();
		return (
			!key ||
			Boolean(props.disabled?.()) ||
			!props.queue.canMutate(key) ||
			props.composer.state().sending ||
			props.composer.readOnly() ||
			props.composer.compacting()
		);
	};
	const scrollMaxHeight = () => {
		if (!props.touch) {
			return Math.min(240, windowSize().height / 4);
		}
		const availableHeight =
			props.availableHeight?.() ?? windowSize().height - keyboardFrame().height;
		return Math.min(200, Math.max(104, Math.round(availableHeight * 0.25)));
	};

	return () => {
		const current = items();
		if (current.length === 0) return null;
		const touch = Boolean(props.touch);
		return (
			<View
				testID="chat-pending-queue"
				class={classNames(
					touch ? "mb-1.5" : "mb-1",
					"w-full min-w-0 shrink-0 overflow-hidden rounded-xl border border-border/60 bg-muted",
				)}
			>
				<View
					class={classNames(
						"flex-row items-center justify-between border-b border-border/40 px-3",
						touch ? "py-2" : "py-1.5",
					)}
				>
					<Text
						role="header"
						class={classNames(
							"font-sans font-medium text-foreground/80",
							!touch && "text-xs",
						)}
						style={touch ? TOUCH_TEXT.body : undefined}
					>
						{() => t("chat.pendingMessages")}
					</Text>
					<Text
						testID="chat-pending-queue-count"
						class={classNames(
							"min-w-7 shrink-0 text-center font-sans tabular-nums text-muted-foreground",
							!touch && "text-xs",
						)}
						style={touch ? TOUCH_TEXT.body : undefined}
					>
						{() => String(items().length)}
					</Text>
				</View>
				<Scroll
					class="min-h-0"
					style={{ maxHeight: scrollMaxHeight() }}
					bounces={false}
					scrollbar={{ vertical: scrollbarLook() }}
				>
					<Each of={items()} key={(entry) => entry.key}>
						{(entry, index) => {
							const label = () => {
								const submission = entry().submission;
								return (
									submission.text ||
									t("chat.queuedImages", { count: submission.images.length })
								);
							};
							return (
								<View
									testID={`chat-pending-item-${index()}`}
									class={classNames(
										"min-w-0 flex-row items-center gap-2",
										touch ? "py-1.5 pl-3 pr-1.5" : "px-3 py-2",
										index() > 0 && "border-t border-border/30",
									)}
								>
									<Text
										class={classNames(
											"shrink-0 font-sans text-muted-foreground",
											!touch && "text-[11px]",
										)}
										style={touch ? TOUCH_TEXT.badge : undefined}
									>
										{() =>
											t(
												entry().kind === "steer"
													? "chat.adjust"
													: "chat.queuedFollowUp",
											)
										}
									</Text>
									<View
										class="w-0 min-w-0 flex-1"
										tooltip={
											touch ? undefined : (
												<Tooltip class="max-w-96" delay={300} margin={12}>
													<Text class="font-sans text-xs">{label}</Text>
												</Tooltip>
											)
										}
									>
										<Text
											class={classNames(
												"font-sans text-foreground/80",
												touch ? "line-clamp-2" : "truncate text-xs",
											)}
											style={touch ? TOUCH_TEXT.body : undefined}
										>
											{label}
										</Text>
									</View>
									<View
										class={classNames(
											"shrink-0 flex-row items-center",
											touch ? "gap-0.5" : "gap-1",
										)}
									>
										<Button
											testID={`chat-pending-edit-${index()}`}
											variant="ghost"
											size="icon"
											class={touch ? "size-10 rounded-md" : "size-7 rounded-md"}
											accessibilityLabel={t("chat.retrieveEdit")}
											tooltip={
												touch
													? undefined
													: textTooltip(() => t("chat.retrieveEdit"))
											}
											disabled={actionsDisabled() || entry().id === null}
											onPress={() => {
												const id = entry().id;
												if (id !== null) {
													void props.queue.change(props.composer, id, "edit");
												}
											}}
										>
											<Icon
												name="Pencil"
												size={touch ? 16 : 14}
												color={token("muted-foreground")}
											/>
										</Button>
										<Button
											testID={`chat-pending-send-now-${index()}`}
											variant="ghost"
											size="icon"
											class={classNames(
												touch ? "size-10 rounded-md" : "size-7 rounded-md",
												"hover:bg-destructive/10",
											)}
											accessibilityLabel={t("chat.interruptSend")}
											tooltip={
												touch
													? undefined
													: textTooltip(() => t("chat.interruptSend"))
											}
											disabled={actionsDisabled() || entry().id === null}
											onPress={() => {
												const id = entry().id;
												if (id !== null) {
													void props.queue.change(
														props.composer,
														id,
														"send_now",
													);
												}
											}}
										>
											<Icon
												name="Zap"
												size={touch ? 16 : 14}
												color={token("destructive")}
											/>
										</Button>
										<Button
											testID={`chat-pending-remove-${index()}`}
											variant="ghost"
											size="icon"
											class={touch ? "size-10 rounded-md" : "size-7 rounded-md"}
											accessibilityLabel={t("chat.removeQueuedMessage")}
											tooltip={
												touch
													? undefined
													: textTooltip(() => t("chat.removeQueuedMessage"))
											}
											disabled={actionsDisabled() || entry().id === null}
											onPress={() => {
												const id = entry().id;
												if (id !== null) {
													void props.queue.change(props.composer, id, "remove");
												}
											}}
										>
											<Icon
												name="X"
												size={touch ? 16 : 14}
												color={token("muted-foreground")}
											/>
										</Button>
									</View>
								</View>
							);
						}}
					</Each>
				</Scroll>
			</View>
		);
	};
}
