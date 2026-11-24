import {
	type Accessor,
	appInfo,
	computed,
	effect,
	openUrl as defaultOpenUrl,
	signal,
	untracked,
} from "nsh";
import { Application } from "nsh/desktop";
import {
	type AppUpdate,
	checkForUpdate as defaultCheckForUpdate,
	downloadUpdate as defaultDownloadUpdate,
	installOnQuit,
	type UpdateCheckOptions,
	type UpdateProgress,
} from "nsh/updater";

import { userErrorMessage } from "@shared/app-error";
import { appLocale, t } from "./i18n";

export const REPOSITORY_URL = "https://github.com/hsingjui/pilo";
export const RELEASES_URL = `${REPOSITORY_URL}/releases`;
const GITHUB_RELEASE_API_URL =
	"https://api.github.com/repos/hsingjui/pilo/releases/tags";
const RELEASE_NOTES_TIMEOUT_MS = 15_000;

export type DesktopUpdateStatus =
	| "idle"
	| "checking"
	| "latest"
	| "available"
	| "downloading"
	| "installing"
	| "error";

export interface DesktopUpdaterApi {
	checkForUpdate: (
		options?: UpdateCheckOptions | null,
	) => Promise<AppUpdate | null>;
	downloadUpdate: (
		onProgress?: ((progress: UpdateProgress) => void) | null,
	) => Promise<void>;
	installAndRestart: () => Promise<void>;
	openUrl: (url: string) => Promise<unknown>;
}

export type ReleaseNotesFetcher = (
	tag: string,
	signal: AbortSignal,
) => Promise<string | null>;

export interface DesktopUpdateOptions {
	updater?: Partial<DesktopUpdaterApi>;
	fetchReleaseNotes?: ReleaseNotesFetcher;
	/** Restarts via the desktop shell after it shuts down the Host. */
	restart?: () => Promise<void>;
	/** Checks silently on startup when true; defaults to `!isDev`. */
	autoCheck?: boolean;
	/** Enables the dev-only preview prompt; defaults to `appInfo().development`. */
	isDev?: boolean;
}

/** Maps an updater error to a user-facing message, as React's `formatUpdateError`. */
export function formatUpdateError(caught: unknown): string {
	const message = userErrorMessage(caught);
	if (/public key|signature/i.test(message)) {
		return t("about.updateConfigUnavailable");
	}
	if (/network|fetch/i.test(message)) {
		return t("about.updateServiceUnavailable");
	}
	return message || t("about.updateFailed");
}

/** Normalizes a version string to its GitHub Release tag (`0.4.2` → `v0.4.2`). */
export function releaseTagForVersion(version: string): string {
	return version.startsWith("v") ? version : `v${version}`;
}

/** The GitHub Releases page for a specific version, or all releases without one. */
export function releasePageUrl(version: string | null): string {
	if (!version) return RELEASES_URL;
	return `${RELEASES_URL}/tag/${encodeURIComponent(releaseTagForVersion(version))}`;
}

/**
 * Strips the installer instructions appended by the release workflow so they
 * stay on GitHub Releases rather than crowding the in-app update dialog.
 */
export function stripReleaseInstallNotes(
	raw: string | null | undefined,
): string | null {
	return (
		raw
			?.replace(/^(?:---[ \t]*\r?\n\s*)?### 下载安装[ \t]*\r?$[\s\S]*/m, "")
			.trim() || null
	);
}

/** Formats downloaded/total bytes in decimal megabytes with one decimal place. */
export function formatUpdateMegabytes(bytes: number, locale: string): string {
	const mb = bytes / 1_000_000;
	try {
		const formatted = new Intl.NumberFormat(locale, {
			minimumFractionDigits: 1,
			maximumFractionDigits: 1,
		}).format(mb);
		return `${formatted} MB`;
	} catch {
		return `${mb.toFixed(1)} MB`;
	}
}

async function fetchGitHubReleaseNotes(
	tag: string,
	abortSignal: AbortSignal,
): Promise<string | null> {
	const response = await fetch(
		`${GITHUB_RELEASE_API_URL}/${encodeURIComponent(tag)}`,
		{
			headers: { Accept: "application/vnd.github+json" },
			signal: abortSignal,
		},
	);
	if (!response.ok) {
		throw new Error(`GitHub Release: ${response.status}`);
	}
	const data: unknown = await response.json();
	if (
		typeof data !== "object" ||
		data === null ||
		!("body" in data) ||
		(typeof data.body !== "string" && data.body !== null)
	) {
		throw new Error("Invalid GitHub Release body");
	}
	return data.body?.trim() || null;
}

/**
 * Shared desktop update state for the sidebar update button, the About pane,
 * and the update dialog — mirroring the Tauri `useDesktopUpdate` contract.
 */
export function createDesktopUpdate(options: DesktopUpdateOptions = {}) {
	const updater: DesktopUpdaterApi = {
		checkForUpdate: options.updater?.checkForUpdate ?? defaultCheckForUpdate,
		downloadUpdate: options.updater?.downloadUpdate ?? defaultDownloadUpdate,
		installAndRestart:
			options.updater?.installAndRestart ??
			(async () => {
				await installOnQuit();
				if (options.restart) await options.restart();
				else Application.restart();
			}),
		openUrl: options.updater?.openUrl ?? defaultOpenUrl,
	};
	const fetchReleaseNotes =
		options.fetchReleaseNotes ?? fetchGitHubReleaseNotes;
	const isDev = options.isDev ?? appInfo().development;
	const autoCheck = options.autoCheck ?? !isDev;

	const status = signal<DesktopUpdateStatus>("idle");
	const previewMode = signal(false);
	const dialogOpen = signal(false);
	const availableVersion = signal<string | null>(null);
	const releaseNotes = signal<string | null>(null);
	const updateUrl = signal<string | null>(null);
	const canInstall = signal(true);
	const error = signal<string | null>(null);
	const downloadedBytes = signal(0);
	const downloadTotalBytes = signal<number | null>(null);

	let checking = false;
	let openOnAvailable = false;
	let installing = false;
	let requestId = 0;

	const downloadProgress = computed(() => {
		const total = downloadTotalBytes();
		if (!total || total <= 0) return null;
		return Math.min(100, Math.round((downloadedBytes() / total) * 100));
	});

	const hasUpdate = computed(() => availableVersion() !== null);

	const setDialogOpen = (open: boolean) => {
		dialogOpen.set(open);
	};

	const checkForUpdates = async ({ openDialog = true } = {}) => {
		if (installing) {
			if (openDialog) dialogOpen.set(true);
			return;
		}
		if (checking) {
			if (openDialog) openOnAvailable = true;
			return;
		}
		openOnAvailable = openDialog;
		checking = true;
		const currentRequest = ++requestId;
		status.set("checking");
		previewMode.set(false);
		error.set(null);
		dialogOpen.set(false);
		availableVersion.set(null);
		releaseNotes.set(null);
		updateUrl.set(null);
		canInstall.set(true);
		downloadedBytes.set(0);
		downloadTotalBytes.set(null);

		try {
			const update = await updater.checkForUpdate({ locale: appLocale() });
			if (currentRequest !== requestId) return;
			if (!update) {
				status.set("latest");
				return;
			}
			availableVersion.set(update.version);
			releaseNotes.set(update.notes ?? null);
			updateUrl.set(update.url);
			canInstall.set(update.canInstall);
			status.set("available");
			if (openOnAvailable) dialogOpen.set(true);
		} catch (caught) {
			if (currentRequest !== requestId) return;
			error.set(formatUpdateError(caught));
			status.set("error");
		} finally {
			if (currentRequest === requestId) checking = false;
		}
	};

	const previewUpdate = () => {
		if (!isDev || installing) return;
		requestId++;
		checking = false;
		previewMode.set(true);
		availableVersion.set("99.0.0-preview");
		releaseNotes.set(null);
		updateUrl.set(null);
		canInstall.set(true);
		error.set(null);
		downloadedBytes.set(0);
		downloadTotalBytes.set(null);
		status.set("available");
		dialogOpen.set(true);
	};

	const installUpdate = async (onNotice?: (message: string) => void) => {
		if (isDev && previewMode()) {
			onNotice?.(t("settings.updatePreviewOnly"));
			return;
		}
		if (status() === "error") {
			await checkForUpdates({ openDialog: true });
			return;
		}
		const version = availableVersion();
		if (!version || checking || installing) return;
		if (!canInstall()) {
			const url = updateUrl() ?? releasePageUrl(version);
			try {
				await updater.openUrl(url);
			} catch (caught) {
				error.set(formatUpdateError(caught));
				status.set("error");
			}
			return;
		}
		installing = true;
		status.set("downloading");
		error.set(null);
		downloadedBytes.set(0);
		downloadTotalBytes.set(null);

		try {
			await updater.downloadUpdate((event) => {
				downloadedBytes.set(event.received);
				downloadTotalBytes.set(event.total ?? null);
			});
			status.set("installing");
			await updater.installAndRestart();
		} catch (caught) {
			error.set(formatUpdateError(caught));
			status.set("error");
		} finally {
			installing = false;
		}
	};

	const dispose = () => {
		requestId++;
		checking = false;
	};

	if (autoCheck) {
		void checkForUpdates({ openDialog: false });
	}

	return {
		status,
		previewMode,
		dialogOpen,
		availableVersion,
		releaseNotes,
		updateUrl,
		canInstall,
		error,
		downloadedBytes,
		downloadTotalBytes,
		downloadProgress,
		hasUpdate,
		isDev,
		fetchReleaseNotes,
		openUrl: updater.openUrl,
		setDialogOpen,
		checkForUpdates,
		installUpdate,
		previewUpdate,
		dispose,
	};
}

export type DesktopUpdate = ReturnType<typeof createDesktopUpdate>;

/**
 * Loads GitHub Release notes for the dialog's active version, falling back to
 * the updater manifest's notes when GitHub cannot be reached.
 */
export function createReleaseNotes(
	version: Accessor<string | null>,
	fallbackNotes: Accessor<string | null>,
	enabled: Accessor<boolean>,
	options: {
		fetchReleaseNotes?: ReleaseNotesFetcher;
		openUrl?: (url: string) => Promise<unknown>;
	} = {},
) {
	const fetchNotes = options.fetchReleaseNotes ?? fetchGitHubReleaseNotes;
	const openExternalUrl = options.openUrl ?? defaultOpenUrl;
	const result = signal<{
		version: string;
		notes: string | null;
		failed: boolean;
	} | null>(null);

	effect(() => {
		const isEnabled = enabled();
		const targetVersion = version();
		if (!isEnabled) {
			// Clear failures on close so reopening retries without looping.
			untracked(() =>
				result.update((current) => (current?.failed ? null : current)),
			);
			return;
		}
		if (!targetVersion) return;
		const existing = untracked(result);
		if (existing?.version === targetVersion) return;

		const tag = releaseTagForVersion(targetVersion);
		const controller = new AbortController();
		let active = true;
		const timeout = setTimeout(
			() => controller.abort(),
			RELEASE_NOTES_TIMEOUT_MS,
		);

		void fetchNotes(tag, controller.signal)
			.then((notes) => {
				if (active) {
					result.set({
						version: targetVersion,
						notes: notes?.trim() || null,
						failed: false,
					});
				}
			})
			.catch(() => {
				if (active) {
					result.set({
						version: targetVersion,
						notes: null,
						failed: true,
					});
				}
			})
			.finally(() => clearTimeout(timeout));

		return () => {
			active = false;
			clearTimeout(timeout);
			controller.abort();
		};
	});

	const currentResult = computed(() => {
		const targetVersion = version();
		const current = result();
		return targetVersion !== null && current?.version === targetVersion
			? current
			: null;
	});

	const notes = computed(() =>
		stripReleaseInstallNotes(currentResult()?.notes ?? fallbackNotes()),
	);

	const loading = computed(
		() => enabled() && version() !== null && currentResult() === null,
	);

	const failed = computed(() => currentResult()?.failed ?? false);

	const openRelease = () => {
		const url = releasePageUrl(version());
		void openExternalUrl(url).catch((caught: unknown) => {
			console.error("Failed to open GitHub Release", caught);
		});
	};

	return {
		notes,
		loading,
		failed,
		openRelease,
	};
}
