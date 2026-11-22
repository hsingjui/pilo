import { Timer, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
	cacheKeepAliveNoticeDelay,
	cacheKeepAliveStatusMessage,
	cacheKeepAliveUsage,
	type CacheKeepAliveStatus,
} from "@shared/cache-keep-alive";
import { Button, NoticeCard, NoticeIcon } from "@/ui";

export function CacheKeepAliveStatusContent({
	status,
}: {
	status: CacheKeepAliveStatus;
}) {
	const { t, i18n } = useTranslation();
	const text = t(cacheKeepAliveStatusMessage(status), {
		time: status.nextWarmAtMs
			? new Date(status.nextWarmAtMs).toLocaleTimeString()
			: "—",
	});
	return (
		<div className="flex min-w-0 flex-1 flex-col gap-y-0.5 text-xs leading-5 wrap-anywhere text-muted-foreground @min-[32rem]:flex-row @min-[32rem]:flex-wrap @min-[32rem]:items-baseline @min-[32rem]:gap-x-3 @min-[32rem]:gap-y-0">
			<p>{text}</p>
			{status.requestCount > 0 ? (
				<p>
					{t(
						"settings.cacheKeepAliveUsage",
						cacheKeepAliveUsage(status, i18n.language),
					)}
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
	const delay = cacheKeepAliveNoticeDelay(status, now);
	useEffect(() => {
		if (dismissed || delay === null || delay === 0) return;
		const remaining = cacheKeepAliveNoticeDelay(status, Date.now());
		if (remaining === null) return;
		const timer = window.setTimeout(() => setNow(Date.now()), remaining);
		return () => window.clearTimeout(timer);
	}, [dismissed, delay, status]);
	if (dismissed || !status || delay !== 0) return null;
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
