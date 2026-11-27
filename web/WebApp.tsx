import { cleanup, computed, mount, signal, UrlScheme, View } from "nsh";
import { Head } from "nsh/web";

import { isRemotePairingUrl } from "@shared/remote-pairing";
import { resolveWebFontMetrics } from "@shared/web-font-scale";

import { showStartupTheme } from "../app/shell/appearance";
import { appLocale, initializeI18n, t } from "../app/shell/i18n";
import { Spinner } from "../app/ui/spinner";
import { ErrorState } from "../app/ui/state-view";
import { MobileAuthRequiredView } from "./mobile-auth-required-view";
import type { MobileRemoteWorkspaceProps } from "./mobile-remote-workspace";
import { installMobileViewportSync, MobileViewport } from "./mobile-viewport";
import { RemotePairingPage } from "./pairing-page";
import { createWebColorScheme, WebColorScheme } from "./web-color-scheme";
import { createWebFontScale, WebFontScale } from "./web-font-scale";
import {
	clearRemoteDeviceToken,
	loadRemoteDeviceToken,
	reloadRemotePage,
	resolveCurrentPageUrl,
	saveRemoteDeviceToken,
	verifyRemoteToken,
} from "./web-remote-client";

initializeI18n();

let workspaceModulePromise:
	| Promise<typeof import("./mobile-remote-workspace")>
	| undefined;

function loadWorkspaceModule() {
	workspaceModulePromise ??= import("./mobile-remote-workspace").catch(
		(error) => {
			workspaceModulePromise = undefined;
			throw error;
		},
	);
	return workspaceModulePromise;
}

function LazyMobileRemoteWorkspace(props: MobileRemoteWorkspaceProps) {
	const workspace = signal<
		typeof import("./mobile-remote-workspace") | "error" | null
	>(null);
	let alive = true;
	cleanup(() => {
		alive = false;
	});

	void loadWorkspaceModule().then(
		(module) => {
			if (alive) workspace.set(module);
		},
		() => {
			if (alive) workspace.set("error");
		},
	);

	return () => {
		const loaded = workspace();
		if (loaded === "error") {
			return (
				<ErrorState
					class="flex-1"
					title={() => t("common.loadFailed")}
					retryLabel={() => t("common.retry")}
					onRetry={reloadRemotePage}
				/>
			);
		}
		if (!loaded) {
			return (
				<View class="flex-1 items-center justify-center">
					<Spinner accessibilityLabel={t("common.loading")} />
				</View>
			);
		}
		const { MobileRemoteWorkspace } = loaded;
		return (
			<MobileRemoteWorkspace
				token={props.token}
				onAuthExpired={props.onAuthExpired}
				onSignOut={props.onSignOut}
			/>
		);
	};
}

function WebAppRoot() {
	const mobileViewport = installMobileViewportSync();
	const webColorScheme = createWebColorScheme();
	const webFontScale = createWebFontScale();
	const currentUrl = signal(resolveCurrentPageUrl());
	const isPairingRoute = computed(() => isRemotePairingUrl(currentUrl()));
	const token = signal<string | null>(null);
	const ready = signal(false);
	const authError = signal<string | null>(null);
	const tokens = computed(() => {
		const value = token();
		return value ? [value] : [];
	});

	const stopUrlWatch = UrlScheme.on("change", ({ url }) => {
		currentUrl.set(url);
	});
	cleanup(stopUrlWatch);

	if (!isPairingRoute()) {
		// Prefetch the workspace bundle in parallel with startup theme & token hydration.
		void loadWorkspaceModule().catch(() => {});
	}
	void Promise.all([
		Promise.all([webColorScheme.ready, webFontScale.ready]).then(
			([schemeOverride, fontScale]) => {
				const metrics = resolveWebFontMetrics(fontScale);
				return showStartupTheme({
					schemeOverride,
					uiTextScale: metrics.uiTextScale,
					codeFontSize: metrics.codeFontSize,
				});
			},
		),
		loadRemoteDeviceToken(),
	])
		.then(([, loadedToken]) => {
			token.set(loadedToken);
		})
		.finally(() => {
			ready.set(true);
		});

	const handleAuthExpired = () => {
		token.set(null);
		authError.set(t("settings.remoteAuthorizationExpired"));
	};

	const handleSignOut = () => {
		void clearRemoteDeviceToken().finally(() => {
			authError.set(null);
			token.set(null);
		});
	};

	let tokenSubmitVersion = 0;
	const handleSubmitToken = (value: string) => {
		const trimmed = value.trim();
		if (!trimmed) return;
		const version = ++tokenSubmitVersion;
		authError.set(null);
		void (async () => {
			try {
				await verifyRemoteToken(trimmed);
				await saveRemoteDeviceToken(trimmed);
				if (version === tokenSubmitVersion) token.set(trimmed);
			} catch (error) {
				if (version !== tokenSubmitVersion) return;
				authError.set(
					error instanceof Error && error.message === "REMOTE_AUTH_EXPIRED"
						? t("settings.remoteManualTokenInvalid")
						: t("settings.remotePairingNetworkError"),
				);
			}
		})();
	};

	const enterWorkspace = (pairedToken?: string) => {
		authError.set(null);
		if (pairedToken) {
			token.set(pairedToken);
		} else {
			void loadRemoteDeviceToken().then((loaded) => {
				token.set(loaded);
			});
		}
		currentUrl.set(new URL("/", resolveCurrentPageUrl()).href);
	};

	return (
		<WebColorScheme.Provider value={webColorScheme}>
			<WebFontScale.Provider value={webFontScale}>
				<MobileViewport.Provider value={mobileViewport}>
					<View class="flex-1 bg-background">
						<Head
							title="Pilo"
							lang={appLocale()}
							meta={[
								{ name: "apple-mobile-web-app-capable", content: "yes" },
								{
									name: "apple-mobile-web-app-status-bar-style",
									content: "black-translucent",
								},
								{ name: "apple-mobile-web-app-title", content: "Pilo" },
							]}
						/>
						{() => {
							if (isPairingRoute()) {
								return (
									<RemotePairingPage
										onPaired={(pairedToken) => enterWorkspace(pairedToken)}
										onOpenApp={() => enterWorkspace()}
									/>
								);
							}
							if (!ready()) return <View class="flex-1 bg-background" />;
							if (!token()) {
								return (
									<MobileAuthRequiredView
										error={authError}
										onSubmitToken={handleSubmitToken}
									/>
								);
							}
							return (
								<Each of={tokens()} key={(value) => value}>
									{(value) => (
										<LazyMobileRemoteWorkspace
											token={value()}
											onAuthExpired={handleAuthExpired}
											onSignOut={handleSignOut}
										/>
									)}
								</Each>
							);
						}}
					</View>
				</MobileViewport.Provider>
			</WebFontScale.Provider>
		</WebColorScheme.Provider>
	);
}

mount(WebAppRoot);
