import type { NotificationPermission, NotificationPress } from "nsh";
import { expect, open, test } from "nsh/test";
import { platform } from "process";

import type { Connection } from "@shared/api/pi-runtime-types";
import type { Project } from "@shared/api/projects-types";
import type { SessionIndexEntry } from "@shared/api/sessions-types";
import {
	createDesktopNotifications,
	type DesktopNotificationsApi,
	type DesktopNotificationsNative,
} from "../shell/desktop-notifications";
import { initializeI18n } from "../shell/i18n";
import { connectSessionNotifications } from "../shell/session-notifications";
import { AppStore } from "../state/app-store";
import { HOST_DEFAULT_VALUES, scriptedClient } from "./scripted-app-client";

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test("fallback mode routes notifications through native module without touching nsh Notifications", async () => {
	let nshTouched = false;
	const nshStub = {
		permission: () => {
			nshTouched = true;
			return Promise.resolve("unavailable" as NotificationPermission);
		},
		requestPermission: () => {
			nshTouched = true;
			return Promise.resolve("unavailable" as NotificationPermission);
		},
		show: () => {
			nshTouched = true;
			return Promise.resolve(false);
		},
		on: () => {
			nshTouched = true;
			return () => undefined;
		},
	};

	const shown: Array<{
		id: string;
		title: string;
		body: string;
		waitForClick: boolean;
	}> = [];
	const waiters: Array<(id: string | null) => void> = [];
	let stopped = 0;
	const native: DesktopNotificationsNative = {
		isFallbackAvailable: () => true,
		show: async (id, title, body, waitForClick) => {
			shown.push({ id, title, body, waitForClick });
			return true;
		},
		nextPress: () =>
			new Promise<string | null>((resolve) => {
				waiters.push(resolve);
			}),
		stopPressListener: () => {
			stopped += 1;
			waiters.shift()?.(null);
		},
	};

	const api = createDesktopNotifications(native, nshStub);
	expect(await api.permission()).toBe("granted");
	expect(await api.requestPermission()).toBe("granted");
	expect(
		await api.show({
			id: "pilo-session:1",
			title: "Done",
			body: "Body",
			waitForClick: true,
		}),
	).toBe(true);
	expect(shown).toEqual([
		{ id: "pilo-session:1", title: "Done", body: "Body", waitForClick: true },
	]);

	const pressed: NotificationPress[] = [];
	const unsub = api.onPress((press) => pressed.push(press));
	await flush();
	expect(waiters.length).toBe(1);
	waiters.shift()?.("pilo-session:1");
	await flush();
	expect(pressed).toEqual([{ id: "pilo-session:1" }]);

	unsub();
	expect(stopped).toBe(1);
	expect(nshTouched).toBe(false);
});

test("packaged mode delegates directly to nsh Notifications", async () => {
	let nativeTouched = false;
	const native: DesktopNotificationsNative = {
		isFallbackAvailable: () => false,
		show: async () => {
			nativeTouched = true;
			return false;
		},
		nextPress: async () => {
			nativeTouched = true;
			return null;
		},
		stopPressListener: () => {
			nativeTouched = true;
		},
	};

	const listeners: Array<(press: NotificationPress) => void> = [];
	const nshShown: Array<{ id: string; title: string; body?: string | null }> =
		[];
	const nshStub = {
		permission: () => Promise.resolve("default" as NotificationPermission),
		requestPermission: () =>
			Promise.resolve("granted" as NotificationPermission),
		show: async (options: {
			id: string;
			title: string;
			body?: string | null;
		}) => {
			nshShown.push(options);
			return true;
		},
		on: (_event: "press", next: (press: NotificationPress) => void) => {
			listeners.push(next);
			return () => {
				const index = listeners.indexOf(next);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
	};

	const api = createDesktopNotifications(native, nshStub);
	expect(await api.permission()).toBe("default");
	expect(await api.requestPermission()).toBe("granted");
	expect(await api.show({ id: "test", title: "Hi", body: "There" })).toBe(true);
	expect(nshShown).toEqual([{ id: "test", title: "Hi", body: "There" }]);

	const pressed: NotificationPress[] = [];
	const unsub = api.onPress((press) => pressed.push(press));
	listeners[0]?.({ id: "test" });
	expect(pressed).toEqual([{ id: "test" }]);
	unsub();
	expect(listeners.length).toBe(0);
	expect(nativeTouched).toBe(false);
});

test("connectSessionNotifications sends on completion and navigates on click", async () => {
	initializeI18n();
	const project = {
		id: "p1",
		name: "pilo",
		path: "/code/pilo",
		connection: {
			id: "local",
			name: "Local",
			kind: { type: "local" },
		} as Connection,
	} as Project;
	const sessionPath = "/sessions/s1.jsonl";
	const runtime = scriptedClient({
		projects: [project],
		sessions: async (projectId) =>
			projectId === "p1"
				? [
						{
							projectId: "p1",
							sessionPath,
							piSessionId: "s1",
							name: "Fix notifications",
							titleOverride: null,
							pinned: false,
						} as SessionIndexEntry,
					]
				: [],
		chatSessions: [
			{
				sessionKey: "k1",
				projectId: "p1",
				sessionPath,
				prepared: true,
				initialized: true,
				activeTurn: false,
				snapshot: {
					generation: 1,
					state: "running",
					connection: project.connection,
					projectId: "p1",
				},
			},
		],
		preferences: {
			revision: 1,
			values: {
				...HOST_DEFAULT_VALUES,
				desktopNotifications: true,
			},
		},
	});
	const store = new AppStore(runtime.client);
	await store.start();
	await store.loadSessions("p1");

	const shown: Array<{ id: string; title: string; waitForClick?: boolean }> =
		[];
	const pressHandlers: Array<(press: NotificationPress) => void> = [];
	const notifications: DesktopNotificationsApi = {
		permission: () => Promise.resolve("granted"),
		requestPermission: () => Promise.resolve("granted"),
		show: async (options) => {
			shown.push(options);
			return true;
		},
		onPress: (handler) => {
			pressHandlers.push(handler);
			return () => {
				const index = pressHandlers.indexOf(handler);
				if (index >= 0) pressHandlers.splice(index, 1);
			};
		},
	};
	let windowShown = 0;
	const notify = connectSessionNotifications(
		runtime.client,
		store,
		{
			show: () => {
				windowShown += 1;
			},
			isQuitting: () => false,
		},
		notifications,
	);

	await notify({
		sequence: 2,
		type: "assistant_message_end",
		projectId: "p1",
		sessionKey: "k1",
		generation: 1,
		stopReason: "aborted",
		errorMessage: null,
		usage: null,
	});
	expect(shown.length).toBe(0);

	await notify({
		sequence: 3,
		type: "assistant_message_end",
		projectId: "p1",
		sessionKey: "k1",
		generation: 1,
		stopReason: "stop",
		errorMessage: null,
		usage: null,
	});
	expect(shown.length).toBe(1);
	expect(shown[0].waitForClick).toBe(true);
	expect(shown[0].title).toContain("Fix notifications");
	expect(shown[0].id).toBe(
		`pilo-session:${JSON.stringify(["local", "p1", sessionPath])}`,
	);

	for (const id of [
		`pilo-session:${JSON.stringify(["another", "p1", sessionPath])}`,
		"pilo-session:not-json",
		'pilo-session:[42,"p1","somewhere"]',
		"other",
	]) {
		pressHandlers[0]?.({ id });
	}
	await flush();
	expect(windowShown).toBe(0);
	expect(store.state().navigation.session).toBe(null);

	pressHandlers[0]?.({ id: shown[0].id });
	await flush();
	await flush();
	expect(windowShown).toBe(1);
	expect(store.state().navigation.session).toEqual({
		projectId: "p1",
		sessionPath,
	});
	store.selectProject("p1");
	pressHandlers[0]?.({
		id: `pilo-session:${JSON.stringify(["p1", sessionPath])}`,
	});
	await flush();
	expect(windowShown).toBe(2);
	expect(store.state().navigation.session).toEqual({
		projectId: "p1",
		sessionPath,
	});
	store.stop();
});

test("connectSessionNotifications falls back to firstUserMessagePreview and cached sessions", async () => {
	initializeI18n();
	const project = {
		id: "project:local:\\\\?\\D:\\Code\\pilo",
		name: "pilo",
		path: "\\\\?\\D:\\Code\\pilo",
		connection: {
			id: "local",
			name: "Local",
			kind: { type: "local" },
		} as Connection,
	} as Project;
	const indexedPath =
		"C:\\Users\\dev\\.pi/agent\\sessions\\--D--Code-pilo--\\s1.jsonl";
	const piPath =
		"C:\\Users\\dev\\.pi\\agent\\sessions\\--D--Code-pilo--\\s1.jsonl";
	const runtime = scriptedClient({
		projects: [project],
		sessions: async (projectId) =>
			projectId === project.id
				? [
						{
							projectId: project.id,
							sessionPath: indexedPath,
							piSessionId: "s1",
							name: null,
							titleOverride: null,
							firstUserMessagePreview: "Upgrade\n  komari   service",
							pinned: false,
						} as SessionIndexEntry,
					]
				: [],
		chatSessions: [
			{
				sessionKey: "k-preview",
				projectId: project.id,
				sessionPath: piPath,
				prepared: true,
				initialized: true,
				activeTurn: false,
				snapshot: {
					generation: 1,
					state: "running",
					connection: project.connection,
					projectId: project.id,
				},
			},
		],
		preferences: {
			revision: 1,
			values: {
				...HOST_DEFAULT_VALUES,
				desktopNotifications: true,
			},
		},
	});
	const store = new AppStore(runtime.client);
	await store.start();
	// Intentionally do NOT call store.loadSessions(project.id) so the project
	// index is not loaded in UI state yet.

	const shown: Array<{ id: string; title: string }> = [];
	const notifications: DesktopNotificationsApi = {
		permission: () => Promise.resolve("granted"),
		requestPermission: () => Promise.resolve("granted"),
		show: async (options) => {
			shown.push({ id: options.id, title: options.title });
			return true;
		},
		onPress: () => () => undefined,
	};
	const clientWithCache = {
		chatState: runtime.client.chatState,
		listCachedSessions: (projectId: string) =>
			runtime.client.listSessions(projectId),
	};
	const notify = connectSessionNotifications(
		clientWithCache,
		store,
		{
			show: () => undefined,
			isQuitting: () => false,
		},
		notifications,
	);

	await notify({
		sequence: 2,
		type: "assistant_message_end",
		projectId: project.id,
		sessionKey: "k-preview",
		generation: 1,
		stopReason: "stop",
		errorMessage: null,
		usage: null,
	});
	expect(shown.length).toBe(1);
	expect(shown[0].title).toContain("Upgrade komari service");
	store.stop();
});

test("connectSessionNotifications falls back to scan when index and cache lack a title, and matches Windows verbatim/drive-case paths", async () => {
	initializeI18n();
	const project = {
		id: "project:local:\\\\?\\D:\\Code\\pilo",
		name: "pilo",
		path: "\\\\?\\D:\\Code\\pilo",
		connection: {
			id: "local",
			name: "Local",
			kind: { type: "local" },
		} as Connection,
	} as Project;
	const indexedPath =
		"c:\\Users\\dev\\.pi/agent\\sessions\\--D--Code-pilo--\\s2.jsonl";
	const piPath =
		"\\\\?\\C:\\Users\\dev\\.pi\\agent\\sessions\\--D--Code-pilo--\\s2.jsonl";
	const runtime = scriptedClient({
		projects: [project],
		sessions: async (projectId) =>
			projectId === project.id
				? [
						{
							projectId: project.id,
							sessionPath: indexedPath,
							piSessionId: "s2",
							name: null,
							titleOverride: null,
							firstUserMessagePreview: null,
							pinned: false,
						} as SessionIndexEntry,
					]
				: [],
		chatSessions: [
			{
				sessionKey: "k-scan",
				projectId: project.id,
				sessionPath: piPath,
				prepared: true,
				initialized: true,
				activeTurn: false,
				snapshot: {
					generation: 1,
					state: "running",
					connection: project.connection,
					projectId: project.id,
				},
			},
		],
		preferences: {
			revision: 1,
			values: {
				...HOST_DEFAULT_VALUES,
				desktopNotifications: true,
			},
		},
	});
	const store = new AppStore(runtime.client);
	await store.start();
	await store.loadSessions(project.id);

	const shown: Array<{ id: string; title: string }> = [];
	const notifications: DesktopNotificationsApi = {
		permission: () => Promise.resolve("granted"),
		requestPermission: () => Promise.resolve("granted"),
		show: async (options) => {
			shown.push({ id: options.id, title: options.title });
			return true;
		},
		onPress: () => () => undefined,
	};
	let cachedCalls = 0;
	let scanCalls = 0;
	const notify = connectSessionNotifications(
		{
			chatState: runtime.client.chatState,
			listCachedSessions: async () => {
				cachedCalls += 1;
				return [
					{
						projectId: project.id,
						sessionPath: indexedPath,
						piSessionId: "s2",
						name: null,
						titleOverride: null,
						firstUserMessagePreview: null,
						pinned: false,
					} as SessionIndexEntry,
				];
			},
			listSessions: async () => {
				scanCalls += 1;
				return [
					{
						projectId: project.id,
						sessionPath: indexedPath,
						piSessionId: "s2",
						name: "Scanned Windows title",
						titleOverride: null,
						firstUserMessagePreview: null,
						pinned: false,
					} as SessionIndexEntry,
				];
			},
		},
		store,
		{
			show: () => undefined,
			isQuitting: () => false,
		},
		notifications,
	);

	await notify({
		sequence: 2,
		type: "assistant_message_end",
		projectId: project.id,
		sessionKey: "k-scan",
		generation: 1,
		stopReason: "stop",
		errorMessage: null,
		usage: null,
	});
	expect(cachedCalls).toBe(1);
	expect(scanCalls).toBe(1);
	expect(shown.length).toBe(1);
	expect(shown[0].title).toContain("Scanned Windows title");
	store.stop();
});

test("NotificationsPane refreshes permission status after granting and sends test notifications", async () => {
	const app = await open("./notifications-pane-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 500,
		locale: "en-US",
		storage: { "fixture.mode": "grant-on-request" },
	});
	await app.waitFor("text:Not requested");
	expect(app.shows("text:enabled:false")).toBe(true);

	await app.press("id:settings-desktop-notifications");
	await app.waitFor("text:Allowed");
	await app.waitFor("text:enabled:true");

	await app.press("id:settings-send-test-notification");
	await app.waitFor("text:shown:1");
	expect(app.shows("text:Failed to send test notification")).toBe(false);
});

test("NotificationsPane reports failures when permission is denied or test send fails", async () => {
	const deniedApp = await open("./notifications-pane-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 500,
		locale: "en-US",
		storage: { "fixture.mode": "deny-on-request" },
	});
	await deniedApp.waitFor("text:Not requested");
	await deniedApp.press("id:settings-desktop-notifications");
	await deniedApp.waitFor("text:Unable to enable system notifications");
	await deniedApp.waitFor("text:Denied");
	expect(deniedApp.shows("text:enabled:false")).toBe(true);

	const failedSendApp = await open("./notifications-pane-fixture.tsx", {
		platform: "macos",
		width: 800,
		height: 500,
		locale: "en-US",
		storage: { "fixture.mode": "send-fails" },
	});
	await failedSendApp.waitFor("text:Allowed");
	await failedSendApp.press("id:settings-desktop-notifications");
	await failedSendApp.waitFor("text:enabled:true");
	await failedSendApp.press("id:settings-send-test-notification");
	await failedSendApp.waitFor("text:Failed to send test notification");
});

test("native notification fallback is available only on an unpackaged macOS host", async () => {
	const app = await open("./notifications-pane-fixture.tsx", {
		width: 400,
		height: 200,
		locale: "en-US",
		storage: { "fixture.mode": "native-probe" },
	});
	await app.waitFor("id:native-fallback");
	expect(app.shows(`text:${platform === "macos"}`)).toBe(true);
});
