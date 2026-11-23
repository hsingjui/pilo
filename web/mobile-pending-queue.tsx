import { type Accessor, Scroll, Text, View } from "nsh";

import type { ComposerStore } from "../app/composer/composer-store";
import { t } from "../app/shell/i18n";
import { Button } from "../app/ui/button";
import type { RemoteChatQueue } from "./remote-chat-queue";

export function MobilePendingQueue(props: {
	queue: RemoteChatQueue;
	composer: ComposerStore;
	sessionKey: Accessor<string | null>;
	connected: Accessor<boolean>;
}) {
	const items = () => props.queue.items(props.sessionKey());
	const disabled = () => {
		const key = props.sessionKey();
		return (
			!key ||
			!props.connected() ||
			props.queue.busy(key) ||
			props.composer.state().sending ||
			props.composer.readOnly() ||
			props.composer.compacting()
		);
	};
	return () =>
		items().length === 0 ? null : (
			<View class="mb-2 gap-1 rounded-lg border border-border bg-background p-2">
				<Text
					role="header"
					class="px-1 text-xs font-medium text-muted-foreground"
				>
					{t("chat.pendingMessages")}
				</Text>
				<Scroll class="max-h-40" bounces={false}>
					<Each of={items()} key={(entry) => entry.id}>
						{(entry) => (
							<View class="min-w-0 flex-row items-center gap-1 px-1">
								<View class="w-0 min-w-0 flex-1 gap-0.5">
									<Text class="truncate text-sm">
										{() =>
											entry().submission.text ||
											t("chat.queuedImages", {
												count: entry().submission.images.length,
											})
										}
									</Text>
									<Text class="text-xs text-muted-foreground">
										{() =>
											t(
												entry().kind === "steer"
													? "chat.queuedSteer"
													: "chat.queuedFollowUp",
											)
										}
									</Text>
								</View>
								<Button
									variant="ghost"
									size="sm"
									class="min-h-11"
									accessibilityLabel={t("chat.retrieveEdit")}
									disabled={disabled()}
									onPress={() =>
										void props.queue.change(props.composer, entry().id, "edit")
									}
								>
									<Text>{t("chat.edit")}</Text>
								</Button>
								<Button
									variant="ghost"
									size="sm"
									class="min-h-11"
									accessibilityLabel={t("chat.interruptSend")}
									disabled={disabled()}
									onPress={() =>
										void props.queue.change(
											props.composer,
											entry().id,
											"send_now",
										)
									}
								>
									<Text>{t("chat.sendModeNowAction")}</Text>
								</Button>
							</View>
						)}
					</Each>
				</Scroll>
			</View>
		);
}
