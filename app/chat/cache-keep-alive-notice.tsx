import {
	cleanup,
	createMotion,
	effect,
	reduceMotion,
	signal,
	Text,
	token,
	View,
} from "nsh";

import {
	cacheKeepAliveNoticeDelay,
	cacheKeepAliveStatusMessage,
	cacheKeepAliveUsage,
	type CacheKeepAliveStatus,
} from "@shared/cache-keep-alive";
import { appLocale, t } from "../shell/i18n";
import { Button } from "../ui/button";
import { Icon } from "../ui/icon";
import { MOTION } from "../ui/motion";
import { textTooltip } from "../ui/tooltip";
import { chatPx } from "./layout";

const noticeText =
	"min-w-0 shrink font-sans text-xs leading-5 text-muted-foreground";

export function CacheKeepAliveNotice(props: {
	status: () => CacheKeepAliveStatus | null;
	/** 显式停止/暂停本次保活（停止后台计费），与仅隐藏提示区分。 */
	onPause?: () => void;
	/** Touch/mobile layout with larger tap targets. */
	touch?: boolean;
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
		const activeKeepAlive =
			status.status === "scheduled" || status.status === "warming";
		const enter = createMotion({
			enter: reduceMotion()
				? {
						keyframes: { opacity: [0, 1] },
						duration: 80,
						easing: MOTION.easing.standardTuple,
					}
				: {
						keyframes: { opacity: [0, 1], translateY: [4, 0] },
						duration: MOTION.duration.surfaceIn,
						easing: MOTION.easing.standardTuple,
					},
		});
		cleanup(() => enter.stop());
		return (
			<View
				testID="chat-cache-keep-alive-notice"
				class="mb-1 min-w-0 shrink-0 flex-row items-center gap-2 rounded-xl border border-border/60 bg-muted px-3 py-1.5"
				style={enter.style}
				onLayout={({ bounds }) => width.set(bounds.size.width)}
			>
				<Icon
					name="Timer"
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
				{activeKeepAlive && props.onPause ? (
					<Button
						testID="chat-cache-keep-alive-pause"
						variant="ghost"
						size="sm"
						class={
							props.touch ? "min-h-10 shrink-0 px-2.5" : "h-6 shrink-0 px-2"
						}
						onPress={props.onPause}
					>
						<Text class="font-sans text-xs text-foreground/80">
							{() => t("settings.cacheKeepAlivePauseAction")}
						</Text>
					</Button>
				) : null}
				<Button
					testID="chat-cache-keep-alive-hide"
					variant="ghost"
					size="icon"
					class={
						props.touch ? "-my-1 size-10 shrink-0" : "-my-1 size-7 shrink-0"
					}
					accessibilityLabel={
						activeKeepAlive
							? t("settings.cacheKeepAliveHideHint")
							: t("common.close")
					}
					tooltip={
						activeKeepAlive
							? textTooltip(() => t("settings.cacheKeepAliveHideHint"))
							: undefined
					}
					onPress={() => dismissed.set(true)}
				>
					<Icon name="X" size={14} color={token("muted-foreground")} />
				</Button>
			</View>
		);
	};
}
