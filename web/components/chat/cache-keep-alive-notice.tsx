import { Timer, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
	cacheKeepAliveHitRate,
	type CacheKeepAliveStatus,
} from "@shared/cache-keep-alive";
import { Button, NoticeCard, NoticeIcon } from "@/ui";

export function CacheKeepAliveStatusContent({
	status,
}: {
	status: CacheKeepAliveStatus;
}) {
	const { t, i18n } = useTranslation();
	const hitRate = cacheKeepAliveHitRate(status);
	let text;
	switch (status.reason) {
		case "warmed":
		case "scheduled":
			text = t(
				status.reason === "warmed"
					? "settings.cacheKeepAliveWarmed"
					: "settings.cacheKeepAliveScheduled",
				{
					time: status.nextWarmAtMs
						? new Date(status.nextWarmAtMs).toLocaleTimeString()
						: "—",
				},
			);
			break;
		case "window_ending":
			text = t("settings.cacheKeepAliveWindowEnding");
			break;
		case "warming":
			text = t("settings.cacheKeepAliveWarming");
			break;
		case "cache_expired":
			text = t("settings.cacheKeepAliveExpired");
			break;
		case "window_ended":
			text = t("settings.cacheKeepAliveWindowEnded");
			break;
		case "cache_miss":
			text = t("settings.cacheKeepAliveMiss");
			break;
		case "unsupported_request":
			text = t("settings.cacheKeepAliveUnsupported");
			break;
		case "timeout":
		case "request_failed":
			text = t("settings.cacheKeepAliveFailed");
			break;
		case "running":
			text = t("settings.cacheKeepAliveRunning");
			break;
		case "disabled":
			text = t("settings.cacheKeepAliveDisabled");
			break;
		default:
			text = t("settings.cacheKeepAliveWaiting");
	}
	if (!status.ready) text = t("settings.cacheKeepAliveUnsupported");
	return (
		<div className="flex min-w-0 flex-1 flex-col gap-y-0.5 text-xs leading-5 wrap-anywhere text-muted-foreground @min-[32rem]:flex-row @min-[32rem]:flex-wrap @min-[32rem]:items-baseline @min-[32rem]:gap-x-3 @min-[32rem]:gap-y-0">
			<p>{text}</p>
			{status.requestCount > 0 ? (
				<p>
					{t("settings.cacheKeepAliveUsage", {
						count: status.requestCount,
						hitRate:
							hitRate === null
								? "—"
								: new Intl.NumberFormat(i18n.language, {
										style: "percent",
										maximumFractionDigits: 1,
									}).format(hitRate),
						cost: status.cost === null ? "—" : `$${status.cost.toFixed(6)}`,
					})}
				</p>
			) : null}
		</div>
	);
}

export function CacheKeepAliveNotice({
	status,
}: {
	status: CacheKeepAliveStatus | null;
}) {
	const { t } = useTranslation();
	const [dismissed, setDismissed] = useState(false);
	const [now, setNow] = useState(Date.now);
	const nextWarmAtMs = status?.nextWarmAtMs;
	useEffect(() => {
		if (dismissed || nextWarmAtMs == null) return;
		const timer = window.setTimeout(
			() => setNow(Date.now()),
			Math.max(0, nextWarmAtMs - 30_000 - Date.now()),
		);
		return () => window.clearTimeout(timer);
	}, [dismissed, nextWarmAtMs]);
	if (
		dismissed ||
		!status ||
		(status.status === "scheduled" &&
			(nextWarmAtMs == null || nextWarmAtMs - now > 30_000)) ||
		["disabled", "waiting_request", "running", "context_changed"].includes(
			status.reason,
		)
	)
		return null;
	return (
		<NoticeCard
			announce="status"
			ariaLive="polite"
			className="@container flex items-start gap-2.5 px-3 py-2"
		>
			<NoticeIcon
				icon={Timer}
				tone={status.status === "unavailable" ? "warning" : "info"}
			/>
			<CacheKeepAliveStatusContent status={status} />
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="-my-1 size-7 shrink-0 text-muted-foreground pointer-coarse:size-11"
				aria-label={t("common.close")}
				onClick={() => setDismissed(true)}
			>
				<X className="size-3.5" />
			</Button>
		</NoticeCard>
	);
}
