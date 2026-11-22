import {
	Notifications,
	type NotificationPermission,
	type NotificationPress,
} from "nsh";

export type DesktopNotificationShowOptions = {
	id: string;
	title: string;
	body?: string;
	/** Whether to keep waiting for a click callback on the macOS dev fallback. */
	waitForClick?: boolean;
};

export type DesktopNotificationsApi = {
	permission(): Promise<NotificationPermission>;
	requestPermission(): Promise<NotificationPermission>;
	show(options: DesktopNotificationShowOptions): Promise<boolean>;
	onPress(listener: (press: NotificationPress) => void): () => void;
};

export type DesktopNotificationsNative = {
	isFallbackAvailable(): boolean;
	show(
		id: string,
		title: string,
		body: string,
		waitForClick: boolean,
	): Promise<boolean>;
	nextPress(): Promise<string | null>;
	stopPressListener(): void;
};

type NshNotificationsLike = Pick<
	typeof Notifications,
	"permission" | "requestPermission" | "show" | "on"
>;

/** Standard `nsh` notifications backed by the platform notification center. */
export function defaultDesktopNotifications(
	nshNotifications: NshNotificationsLike = Notifications,
): DesktopNotificationsApi {
	return {
		permission: () => nshNotifications.permission(),
		requestPermission: () => nshNotifications.requestPermission(),
		show: ({ id, title, body }) =>
			nshNotifications.show({ id, title, body: body ?? "" }),
		onPress: (listener) => nshNotifications.on("press", listener),
	};
}

/**
 * Selects the macOS dev fallback when running as an unpackaged executable
 * without a `.app` bundle; otherwise delegates to `nsh`'s `Notifications`.
 *
 * When the fallback is active, `nsh`'s `Notifications` is never called so that
 * `mac-notification-sys`'s `NSBundle` swizzle cannot trick `nsh` into touching
 * `UNUserNotificationCenter` without a real bundle.
 */
export function createDesktopNotifications(
	native: DesktopNotificationsNative,
	nshNotifications: NshNotificationsLike = Notifications,
): DesktopNotificationsApi {
	if (!native.isFallbackAvailable()) {
		return defaultDesktopNotifications(nshNotifications);
	}

	const listeners = new Set<(press: NotificationPress) => void>();
	let pumpToken = 0;

	const startPump = () => {
		const token = ++pumpToken;
		void (async () => {
			while (token === pumpToken && listeners.size > 0) {
				let id: string | null;
				try {
					// oxlint-disable-next-line no-await-in-loop -- Serial pull loop for native notification clicks.
					id = await native.nextPress();
				} catch (error: unknown) {
					console.warn("Failed to read desktop notification press", error);
					break;
				}
				if (token !== pumpToken || id === null) break;
				for (const listener of Array.from(listeners)) {
					listener({ id });
				}
			}
		})();
	};

	return {
		permission: () => Promise.resolve("granted"),
		requestPermission: () => Promise.resolve("granted"),
		show: ({ id, title, body, waitForClick }) =>
			native.show(id, title, body ?? "", Boolean(waitForClick)),
		onPress: (listener) => {
			const wasEmpty = listeners.size === 0;
			listeners.add(listener);
			if (wasEmpty) startPump();
			return () => {
				if (!listeners.delete(listener)) return;
				if (listeners.size === 0) {
					pumpToken += 1;
					native.stopPressListener();
				}
			};
		},
	};
}
