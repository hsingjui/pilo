import { computed, effect, mount, signal, Storage, View } from "nsh";
import {
	currentWindow,
	displays,
	isAvailable,
	type Display,
	type WindowRef,
	type WindowState,
} from "nsh/desktop";

import { LOCAL_HOST_ID } from "@shared/host-id";
import {
	createNativeHostClient,
	type NativeHostBackend,
} from "../client/native-transport";
import { AddRemoteHostDialog } from "../hosts/add-remote-host-dialog";
import { HostList } from "../hosts/host-list";
import { setHostPerspective } from "../hosts/host-perspective";
import {
	HostRegistry,
	type HostEntry,
	type RemoteHostCredentials,
} from "../hosts/host-registry";
import { HostSession, LOCAL_HOST_ACCESS } from "../hosts/host-session";
import manifest from "../../nsh.json";
import { AppShell, StartupFrame } from "./AppShell";
import { showStartupTheme } from "./appearance";
import {
	connectDesktopShell,
	type DesktopShell,
	type DesktopWindowShell,
} from "./desktop-shell";
import { appLocale, t } from "./i18n";

function fitMainWindow(main: WindowRef, state: WindowState, display: Display) {
	const area = display.visibleBounds;
	const { origin, size } = state.bounds;
	const { size: content } = state.contentBounds;
	const minSize = manifest.window.minSize;
	const availableWidth = area.size.width - (size.width - content.width);
	const availableHeight = area.size.height - (size.height - content.height);
	if (availableWidth <= 0 || availableHeight <= 0) return;
	const minWidth = Math.max(1, Math.floor(availableWidth * 0.9));
	const minHeight = Math.max(1, Math.floor(availableHeight * 0.9));
	if (minWidth < minSize.width || minHeight < minSize.height) {
		main.set({
			minSize: {
				width: Math.min(minSize.width, minWidth),
				height: Math.min(minSize.height, minHeight),
			},
		});
	}
	const width = Math.min(size.width, area.size.width);
	const height = Math.min(size.height, area.size.height);
	const x = Math.min(
		Math.max(origin.x, area.origin.x),
		area.origin.x + area.size.width - width,
	);
	const y = Math.min(
		Math.max(origin.y, area.origin.y),
		area.origin.y + area.size.height - height,
	);
	if (
		width !== size.width ||
		height !== size.height ||
		x !== origin.x ||
		y !== origin.y
	) {
		main.setBounds({ origin: { x, y }, size: { width, height } });
	}
}

/** The Dock badge, when the platform shows one. */
export type DesktopBadge = { setBadge(count: number): void };

/**
 * Starts the app on `pilo`: the embedded Host's session, then every paired
 * remote Host's, each with its own stores; the window shows one at a time.
 */
export async function launch(
	pilo: NativeHostBackend,
	shell: DesktopShell,
	remote?: {
		credentials: RemoteHostCredentials;
		machineName: () => string | null;
		badge?: DesktopBadge;
	},
) {
	let desktop: DesktopWindowShell | undefined;
	const local = new HostSession({
		hostId: LOCAL_HOST_ID,
		kind: "local",
		client: createNativeHostClient(pilo),
		shell,
		onLiveEvent: (event) => {
			if (event.type === "configuration_changed") {
				void desktop?.refreshExitOnClose();
			}
		},
	});
	const registry = new HostRegistry({
		local,
		shell,
		storage: Storage,
		credentials: remote?.credentials ?? {
			remoteHostToken: () => Promise.resolve(null),
			saveRemoteHostToken: () =>
				Promise.reject(new Error("remote Hosts are unavailable")),
			deleteRemoteHostToken: () => Promise.resolve(),
		},
	});
	const addRemoteOpen = signal(false);
	// The first frame takes the saved theme and sidebar width, so a launch or
	// reload neither flashes the default theme nor resizes its outline.
	const [startupTheme] = await Promise.all([
		showStartupTheme(),
		local.sidebarSettings.load().catch((error: unknown) => {
			console.warn("Failed to load the sidebar settings", error);
		}),
	]);
	const loadedSettings = new WeakSet<HostSession>([local]);
	const showShell = computed(() => {
		const { themeSettings, status } = registry.activeSession().store.state();
		return (
			themeSettings !== null ||
			status.type === "failed" ||
			status.type === "closed"
		);
	});
	const removeHost = (entry: HostEntry) => {
		const toasts = registry.activeSession().toasts;
		void registry.remove(entry.hostId).then(
			(revoked) =>
				toasts.show({
					variant: revoked ? "success" : "info",
					title: t(revoked ? "hosts.removed" : "hosts.removedOffline", {
						name: entry.name,
					}),
				}),
			(error: unknown) =>
				toasts.show({
					variant: "error",
					title: t("hosts.remove"),
					description: error instanceof Error ? error.message : String(error),
				}),
		);
	};
	const hostSwitcher = () => (
		<HostList
			registry={registry}
			onAddRemote={() => addRemoteOpen.set(true)}
			onRemove={removeHost}
		/>
	);
	/** Follows one Host's session for as long as it is open. */
	const SessionRuntime = (props: { session: HostSession }) => {
		const { session } = props;
		session.follow({
			desktop,
			notifications: desktop ? shell.notifications : undefined,
			isActive: () => registry.activeSession() === session,
			onActivate: () => registry.activate(session.hostId),
		});
		if (!loadedSettings.has(session)) {
			loadedSettings.add(session);
			void session.sidebarSettings.load().catch((error: unknown) => {
				console.warn("Failed to load the sidebar settings", error);
			});
		}
		return <View class="hidden" />;
	};
	mount(() => {
		if (isAvailable) {
			// nsh creates the implicit main window as part of mount.
			const main = currentWindow();
			main.set({ title: manifest.name });
			if (shell.settings) {
				desktop = connectDesktopShell(
					main,
					shell.settings,
					() => registry.shutdown(),
					shell.dock,
				);
			}
			// nsh applies the manifest defaults or restores saved geometry first.
			let fitted = false;
			effect(() => {
				if (fitted) return;
				const state = main.state();
				if (!state) return;
				const screens = displays();
				const display =
					state.display ??
					screens.find((screen) => screen.primary) ??
					screens[0];
				if (!display) return;
				fitted = true;
				if (state.mode === "normal" && !state.minimized) {
					fitMainWindow(main, state, display);
				}
			});
		}
		effect(() => {
			const count = registry.unreadCount();
			remote?.badge?.setBadge(count);
		});
		effect(() => {
			const session = registry.activeSession();
			if (session.kind === "local") {
				setHostPerspective(null);
				return;
			}
			const record = registry.record(session.hostId);
			setHostPerspective({
				remoteName: record?.name ?? session.hostId,
				platform: record?.platform ?? "linux",
			});
		});
		// A Host that revoked this device or runs an incompatible Pilo says so once.
		const told = new Map<string, string>();
		effect(() => {
			for (const entry of registry.entries()) {
				const previous = told.get(entry.hostId);
				told.set(entry.hostId, entry.status);
				if (previous === entry.status) continue;
				if (
					entry.status === "unauthorized" ||
					entry.status === "incompatible"
				) {
					registry.activeSession().toasts.show({
						variant: "error",
						title: t(
							entry.status === "unauthorized"
								? "hosts.needsPairing"
								: "hosts.incompatibleHost",
							{ name: entry.name },
						),
					});
				}
			}
		});
		return () => (
			<>
				<Each
					of={registry.sessions()}
					key={(session: HostSession) => session.hostId}
				>
					{(session: () => HostSession) => (
						<SessionRuntime session={session()} />
					)}
				</Each>
				{() => {
					const session = registry.activeSession();
					if (!showShell()) {
						return (
							<StartupFrame
								claude={startupTheme?.themeFamily === "claude"}
								sidebarWidth={session.sidebarSettings.width}
							/>
						);
					}
					const access =
						session.kind === "local"
							? LOCAL_HOST_ACCESS
							: registry.access(session.hostId);
					return (
						<AppShell
							{...session.shellProps(access, shell)}
							desktop={desktop}
							hostSwitcher={remote ? hostSwitcher : undefined}
						/>
					);
				}}
				{remote ? (
					<AddRemoteHostDialog
						open={addRemoteOpen}
						registry={registry}
						machineName={remote.machineName}
						onPaired={(name) =>
							registry.activeSession().toasts.show({
								variant: "success",
								title: t("hosts.paired", { name }),
							})
						}
					/>
				) : null}
			</>
		);
	});
	// Overlap initial theme preload with locale seeding before store bootstrap.
	void local.store.preloadThemeSettings().catch((error: unknown) => {
		console.warn("Failed to preload Host theme", error);
	});
	await local.client
		.savePreferences({ locale: appLocale() }, true)
		.catch((error: unknown) => {
			console.warn("Failed to initialize Host locale", error);
		});
	if (desktop?.isQuitting()) return;
	await local.start();
	if (remote) void registry.load();
}
