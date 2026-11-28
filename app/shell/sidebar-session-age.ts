import { type Accessor, context, effect, signal } from "nsh";

import { t } from "./i18n";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const SidebarSessionClock = context<Accessor<number>>(Date.now);

/** Share one clock across the rows, updating only while the list is mounted. */
export function createSessionAgeClock(visible: Accessor<boolean> = () => true) {
	const now = signal(Date.now());
	effect(() => {
		if (!visible()) return;
		const tick = () => now.set(Date.now());
		tick();
		const timer = setInterval(tick, 15_000);
		return () => clearInterval(timer);
	});
	return now;
}

export function sessionAgeText(updatedAt: Date, now: number): string {
	const elapsed = now - updatedAt.getTime();
	if (!Number.isFinite(elapsed) || elapsed > 7 * DAY_MS) return "";
	if (elapsed >= DAY_MS) return `${Math.floor(elapsed / DAY_MS)}d`;
	if (elapsed >= HOUR_MS) return `${Math.floor(elapsed / HOUR_MS)}h`;
	if (elapsed >= MINUTE_MS) return `${Math.floor(elapsed / MINUTE_MS)}m`;
	return t("sidebar.sessionJustNow");
}
