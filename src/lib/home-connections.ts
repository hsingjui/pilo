/**
 * 首页（侧边栏环境列表）中连接的可见性。
 *
 * 这是纯桌面端展示偏好，不参与 Pi 运行时，因此存 localStorage。
 * 默认只展示 Local；其余连接由用户在设置中显式勾选。
 */
const STORAGE_KEY = "pilo.homeConnections.v1";
const DEFAULT_SHOWN = ["local"];

export const HOME_CONNECTIONS_CHANGED_EVENT = "pilo://home-connections-changed";

function readStoredIds(): string[] {
	if (typeof window === "undefined") return [...DEFAULT_SHOWN];
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return [...DEFAULT_SHOWN];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [...DEFAULT_SHOWN];
		return parsed.filter((id): id is string => typeof id === "string");
	} catch {
		return [...DEFAULT_SHOWN];
	}
}

export function listHomeConnectionIds(): Set<string> {
	return new Set(readStoredIds());
}

export function isConnectionShownInHome(id: string): boolean {
	return listHomeConnectionIds().has(id);
}

export function setConnectionShownInHome(id: string, shown: boolean): void {
	const ids = listHomeConnectionIds();
	if (shown) ids.add(id);
	else ids.delete(id);
	window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
	window.dispatchEvent(new Event(HOME_CONNECTIONS_CHANGED_EVENT));
}
