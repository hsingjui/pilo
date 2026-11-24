import { type Accessor, Scroll, Text, token, View, windowSize } from "nsh";

import type { ComposerStore } from "../composer/composer-store";
import { t } from "../shell/i18n";
import type { ChatQueueStore } from "../state/chat-queue-store";
import { Button } from "../ui/button";
import { classNames } from "../ui/class-names";
import { Icon } from "../ui/icon";
import { scrollbarLook } from "../ui/scrollbar";
import { textTooltip, Tooltip } from "../ui/tooltip";

export interface ChatPendingQueueProps {
	queue: ChatQueueStore;
	composer: ComposerStore;
	sessionKey: Accessor<string | null>;
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
			!props.queue.canMutate(key) ||
			props.composer.state().sending ||
			props.composer.readOnly() ||
			props.composer.compacting()
		);
	};

	return () => {
		const current = items();
		if (current.length === 0) return null;
		return (
			<View
				testID="chat-pending-queue"
				class="mb-1 w-full min-w-0 shrink-0 overflow-hidden rounded-xl border border-border/60 bg-muted"
			>
				<View class="flex-row items-center justify-between border-b border-border/40 px-3 py-1.5">
					<Text
						role="header"
						class="font-sans text-xs font-medium text-foreground/80"
					>
						{() => t("chat.pendingMessages")}
					</Text>
					<Text
						testID="chat-pending-queue-count"
						class="min-w-7 shrink-0 text-center font-sans text-xs tabular-nums text-muted-foreground"
					>
						{() => String(items().length)}
					</Text>
				</View>
				<Scroll
					class="min-h-0"
					style={{ maxHeight: Math.min(240, windowSize().height / 4) }}
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
										"min-w-0 flex-row items-center gap-2 px-3 py-2",
										index() > 0 && "border-t border-border/30",
									)}
								>
									<Text class="shrink-0 font-sans text-[11px] text-muted-foreground">
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
											<Tooltip class="max-w-96" delay={300} margin={12}>
												<Text class="font-sans text-xs">{label}</Text>
											</Tooltip>
										}
									>
										<Text class="truncate font-sans text-xs text-foreground/80">
											{label}
										</Text>
									</View>
									<View class="shrink-0 flex-row items-center gap-1">
										<Button
											testID={`chat-pending-edit-${index()}`}
											variant="ghost"
											size="icon"
											class="size-7 rounded-md"
											accessibilityLabel={t("chat.retrieveEdit")}
											tooltip={textTooltip(() => t("chat.retrieveEdit"))}
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
												size={14}
												color={token("muted-foreground")}
											/>
										</Button>
										<Button
											testID={`chat-pending-send-now-${index()}`}
											variant="ghost"
											size="icon"
											class="size-7 rounded-md"
											accessibilityLabel={t("chat.interruptSend")}
											tooltip={textTooltip(() => t("chat.interruptSend"))}
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
												name="Send"
												size={14}
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
