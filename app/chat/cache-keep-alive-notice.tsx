import { effect, signal, Text, token, View } from "nsh";

import {
	cacheKeepAliveNoticeDelay,
	cacheKeepAliveStatusMessage,
	cacheKeepAliveUsage,
	type CacheKeepAliveStatus,
} from "@shared/cache-keep-alive";
import { appLocale, t } from "../shell/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { chatPx } from "./layout";

const noticeText =
	"min-w-0 shrink font-sans text-xs leading-5 text-muted-foreground";

export function CacheKeepAliveNotice(props: {
	status: () => CacheKeepAliveStatus | null;
}) {
	const dismissed = signal(false);
	const visible = signal(false);
	const width = signal(0);
	// the WebUI's 32rem container query measures the card inside its padding and border.
	const wide = () => width() >= chatPx(512 + 24) + 2;
	effect(() => {
		const delay = dismissed()
			? null
			: cacheKeepAliveNoticeDelay(props.status(), Date.now());
		visible.set(delay === 0);
		if (delay === null || delay === 0) return;
		const timer = setTimeout(() => visible.set(true), delay);
		return () => clearTimeout(timer);
	});

	return () => {
		const status = props.status();
		if (!status || dismissed() || !visible()) return null;
		return (
			<View
				testID="chat-cache-keep-alive-notice"
				class="mb-1 min-w-0 shrink-0 flex-row items-start gap-2.5 rounded-xl border border-border/60 bg-muted px-3 py-2"
				onLayout={({ bounds }) => width.set(bounds.size.width)}
			>
				<Icon
					name="Timer"
					class="mt-0.5"
					size={14}
					color={token(
						status.status === "unavailable"
							? "status-warning"
							: "muted-foreground",
					)}
				/>
				<View
					class={
						wide()
							? "min-w-0 flex-1 flex-row flex-wrap items-baseline gap-x-3"
							: "min-w-0 flex-1 gap-0.5"
					}
				>
					<Text class={noticeText}>
						{t(cacheKeepAliveStatusMessage(status), {
							time: status.nextWarmAtMs
								? new Date(status.nextWarmAtMs).toLocaleTimeString()
								: "—",
						})}
					</Text>
					{status.requestCount > 0 ? (
						<Text class={noticeText}>
							{t(
								"settings.cacheKeepAliveUsage",
								cacheKeepAliveUsage(status, appLocale()),
							)}
						</Text>
					) : null}
				</View>
				<Button
					variant="ghost"
					size="icon"
					class="-my-1 size-7 shrink-0"
					accessibilityLabel={t("common.close")}
					onPress={() => dismissed.set(true)}
				>
					<Icon name="X" size={14} color={token("muted-foreground")} />
				</Button>
			</View>
		);
	};
}
