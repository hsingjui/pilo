import { cleanup, computed, mount, signal, UrlScheme, View } from "nsh";
import { Head } from "nsh/web";

import { isRemotePairingUrl } from "@shared/remote-pairing";

import { showStartupTheme } from "../app/shell/appearance";
import { appLocale, initializeI18n, t } from "../app/shell/i18n";
import { Spinner } from "../app/ui/spinner";
import { ErrorState } from "../app/ui/state-view";
import { MobileAuthRequiredView } from "./mobile-auth-required-view";
import type { MobileRemoteWorkspaceProps } from "./mobile-remote-workspace";
import { installMobileViewportSync, MobileViewport } from "./mobile-viewport";
import { RemotePairingPage } from "./pairing-page";
import {
	clearRemoteDeviceToken,
	loadRemoteDeviceToken,
	reloadRemotePage,
	resolveCurrentPageUrl,
	saveRemoteDeviceToken,
} from "./web-remote-client";

initializeI18n();

function LazyMobileRemoteWorkspace(props: MobileRemoteWorkspaceProps) {
	const workspace = signal<
		typeof import("./mobile-remote-workspace") | "error" | null
	>(null);
	let alive = true;
	cleanup(() => {
		alive = false;
	});

	void import("./mobile-remote-workspace").then(
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

	void Promise.all([showStartupTheme(), loadRemoteDeviceToken()])
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

	const handleSubmitToken = (value: string) => {
		authError.set(null);
		void saveRemoteDeviceToken(value).then(() => {
			token.set(value);
		});
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
		currentUrl.set(resolveCurrentPageUrl());
	};

	return (
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
	);
}

mount(WebAppRoot);
