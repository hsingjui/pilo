import { effect, keymap, platform, signal } from "nsh";
import { Application, GlobalShortcut, Tray, type WindowRef } from "nsh/desktop";

import macTrayIcon from "../assets/tray-template.svg";
// nsh renders SVG tray icons as monochrome templates on Windows too; use the
// pre-rendered RGBA PNG (from assets/branding/tray.svg) to preserve colors.
import windowsTrayIcon from "../assets/tray.png";
import { APP_SHORTCUTS } from "../shortcuts";
import { t } from "./i18n";

export type DesktopSettingsClient = {
	loadDesktopSettings(): Promise<{
		showShortcut: string;
		exitOnClose: boolean;
	}>;
	saveExitOnClose(enabled: boolean): Promise<void>;
	saveShowShortcut(shortcut: string): Promise<void>;
};

export type DesktopDockApi = {
	setVisible(visible: boolean): Promise<boolean>;
	activate?(): void;
};

export type WindowVisibilityTarget = Pick<
	WindowRef,
	"focus" | "hide" | "state"
> & {
	on(
		event: "focusChange",
		listener: (event: { focused: boolean }) => void,
	): () => void;
};

export function createWindowVisibilityController(
	main: WindowVisibilityTarget,
	dock: DesktopDockApi | undefined,
	isQuitting: () => boolean,
) {
	let visibilitySeq = 0;
	// External window reopens can arrive long after the hide request settles.
	let requestedDockVisible = true;

	const syncDockVisible = async (visible: boolean) => {
		if (!dock) return;
		requestedDockVisible = visible;
		try {
			await dock.setVisible(visible);
		} catch (error) {
			console.warn("Failed to update Pilo Dock visibility", error);
		}
	};

	const restoreDock = () => {
		if (isQuitting() || requestedDockVisible) return;
		++visibilitySeq;
		void syncDockVisible(true);
	};

	const show = (fromShortcut: boolean) => {
		if (isQuitting()) return;
		const seq = ++visibilitySeq;
		if (!dock) {
			main.focus();
			return;
		}
		// This only runs once the Dock request landed; a later request must not
		// take the focus or activation it asked for.
		void syncDockVisible(true).then(() => {
			if (isQuitting() || seq !== visibilitySeq) return;
			main.focus();
			if (fromShortcut) dock.activate?.();
		});
	};

	const hide = () => {
		if (isQuitting()) return;
		++visibilitySeq;
		main.hide();
		void syncDockVisible(false);
	};

	let disposed = false;
	const stopFocusListener = main.on("focusChange", ({ focused }) => {
		if (!disposed && focused) restoreDock();
	});

	let wasVisible: boolean | null = null;
	effect(() => {
		if (disposed) return;
		const visible = main.state()?.visible ?? null;
		if (visible === true && wasVisible === false) restoreDock();
		wasVisible = visible;
	});

	return {
		show: () => show(false),
		showFromShortcut: () => show(true),
		hide,
		dispose: () => {
			disposed = true;
			stopFocusListener();
		},
	};
}

function globalShortcutLabel(shortcut: string) {
	const label = keymap.label(shortcut);
	if (Object.values(APP_SHORTCUTS).some((key) => keymap.label(key) === label)) {
		throw new Error("Global shortcut conflicts with a built-in app shortcut");
	}
	return label;
}

export function connectDesktopShell(
	main: WindowRef,
	client: DesktopSettingsClient,
	shutdown: () => Promise<void>,
	dock?: DesktopDockApi,
) {
	const settings = signal<Awaited<
		ReturnType<DesktopSettingsClient["loadDesktopSettings"]>
	> | null>(null);
	const loadFailed = signal(false);
	const registered = signal<string | null>(null);
	const savingShortcut = signal(false);
	const savingClose = signal(false);
	let traySeen = false;
	let quitting = false;

	const { show, showFromShortcut, hide } = createWindowVisibilityController(
		main,
		dock,
		() => quitting,
	);
	const exit = async (restart: boolean) => {
		if (quitting) return;
		quitting = true;
		try {
			await shutdown();
		} catch (error) {
			if (restart) {
				quitting = false;
				throw error;
			}
			console.error("Failed to shut down Pilo", error);
		}
		if (restart) Application.restart();
		else Application.quit();
	};
	const quit = () => exit(false);
	Application.on("quitRequest", quit);
	Application.setQuitRequestOptions({ system: true });
	Application.on("secondInstance", show);
	main.on("closePress", ({ reason }) => {
		// Tray.set has no success result. Don't hide unless there is a known way back.
		if (
			reason !== "system" &&
			settings()?.exitOnClose === false &&
			(traySeen || registered())
		) {
			hide();
		} else {
			void quit();
		}
	});
	main.set({ closeOnPress: false });

	effect(() => {
		const shortcut = registered();
		const label = shortcut
			? `${t("desktop.show")} (${keymap.label(shortcut)})`
			: t("desktop.show");
		const showFromTray = () => {
			traySeen = true;
			show();
		};
		Tray.set({
			tooltip: "Pilo",
			icon: platform.os === "macos" ? macTrayIcon : windowsTrayIcon,
			menu: [
				{ label, onSelect: showFromTray },
				{
					label: t("desktop.hide"),
					onSelect: () => {
						traySeen = true;
						hide();
					},
				},
				{ type: "separator" },
				{ label: t("desktop.quit"), onSelect: () => void quit() },
			],
			...(platform.os === "windows" ? { onClick: showFromTray } : {}),
		});
	});

	async function load() {
		loadFailed.set(false);
		try {
			const saved = await client.loadDesktopSettings();
			if (quitting) return;
			try {
				savingShortcut.set(true);
				settings.set(saved);
				globalShortcutLabel(saved.showShortcut);
				if (
					await GlobalShortcut.register(saved.showShortcut, showFromShortcut)
				) {
					registered.set(saved.showShortcut);
				} else {
					console.warn("Pilo global shortcut is unavailable");
				}
			} catch (error) {
				console.warn("Failed to register Pilo global shortcut", error);
			} finally {
				savingShortcut.set(false);
			}
		} catch (error) {
			loadFailed.set(true);
			console.error("Failed to load Pilo desktop settings", error);
		}
	}

	async function saveShortcut(input: string) {
		if (savingShortcut()) return;
		const shortcut = input.trim().toLowerCase();
		const parts = shortcut.split("+");
		const key = parts.pop() ?? "";
		if (
			shortcut.length > 100 ||
			(!/^f(?:[1-9]|1[0-2])$/.test(key) &&
				!parts.some((modifier) => modifier && modifier !== "shift"))
		) {
			throw new Error("Invalid global shortcut");
		}
		const label = globalShortcutLabel(shortcut);
		const previous = registered();
		// nsh replaces a native binding even when another spelling refers to it.
		if (previous && keymap.label(previous) === label) return;
		savingShortcut.set(true);
		try {
			if (!(await GlobalShortcut.register(shortcut, showFromShortcut))) {
				throw new Error("Global shortcut is unavailable");
			}
			try {
				await client.saveShowShortcut(shortcut);
			} catch (error) {
				GlobalShortcut.unregister(shortcut);
				throw error;
			}
			if (previous) GlobalShortcut.unregister(previous);
			registered.set(shortcut);
			settings.update((saved) => saved && { ...saved, showShortcut: shortcut });
		} finally {
			savingShortcut.set(false);
		}
	}

	async function refreshExitOnClose() {
		if (quitting || savingClose()) return;
		try {
			const saved = await client.loadDesktopSettings();
			if (quitting) return;
			settings.update((current) =>
				current ? { ...current, exitOnClose: saved.exitOnClose } : saved,
			);
		} catch (error) {
			console.warn("Failed to refresh Pilo desktop settings", error);
		}
	}

	void load();
	return {
		settings,
		loadFailed,
		registered,
		savingShortcut,
		savingClose,
		load,
		refreshExitOnClose,
		show,
		restart: () => exit(true),
		isQuitting: () => quitting,
		saveShortcut,
		async saveExitOnClose(enabled: boolean) {
			if (savingClose()) return;
			savingClose.set(true);
			try {
				await client.saveExitOnClose(enabled);
				settings.update((saved) => saved && { ...saved, exitOnClose: enabled });
			} finally {
				savingClose.set(false);
			}
		},
	};
}

export type DesktopShell = ReturnType<typeof connectDesktopShell>;
