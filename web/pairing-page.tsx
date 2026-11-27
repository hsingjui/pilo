import {
	cleanup,
	computed,
	effect,
	lifecycle,
	safeArea,
	Scroll,
	signal,
	Text,
	token,
	untracked,
	UrlScheme,
	View,
} from "nsh";
import { Button as BaseButton } from "nsh/base";

import { sortRemoteAddresses } from "@shared/remote-addresses";
import {
	capturePairingBootFromUrl,
	clearPairingContext,
	pairingReturnUrl,
	pairingTargetAddress,
	pairingTargetUrl,
	preparePairingRequest,
	refreshPairingContext,
	type PairingBoot,
	type PairingStorage,
	type RemotePairingInfo,
} from "@shared/remote-pairing";

import { t } from "../app/shell/i18n";
import { Button } from "../app/ui/button";
import { Icon } from "../app/ui/icon";
import { Spinner } from "../app/ui/spinner";
import { styleVar } from "../app/ui/theme-style";
import {
	browserRandomBytes,
	browserSessionStorage,
	getRemotePairingInfo,
	loadRemoteDeviceToken,
	navigateToUrl,
	pairRemote,
	RemotePairingError,
	resolveCurrentPageUrl,
	resolvePageOrigin,
	saveRemoteDeviceToken,
	verifyRemoteToken,
} from "./web-remote-client";

type Failure =
	| "expired"
	| "used"
	| "storage"
	| "random"
	| "invalid"
	| "network";

function classifyFailure(error: unknown): Failure {
	if (error instanceof RemotePairingError) {
		if (error.status === 401) return "expired";
		if (error.status === 409) return "used";
		if (error.status === 400) return "invalid";
	}
	if (error instanceof Error) {
		if (error.message === "REMOTE_PAIRING_EXPIRED") return "expired";
		if (
			error.message === "REMOTE_PAIRING_STORAGE_UNAVAILABLE" ||
			error.name === "SecurityError" ||
			error.name === "QuotaExceededError"
		) {
			return "storage";
		}
		if (error.message === "REMOTE_PAIRING_RANDOM_UNAVAILABLE") return "random";
		if (error.message.startsWith("REMOTE_PAIRING_INVALID")) return "invalid";
	}
	return "network";
}

export interface RemotePairingPageProps {
	/** Called when the current origin is authorized and the user should enter `/`. */
	onPaired?: (token: string) => void;
	/** Called when the user presses "Open Pilo" to navigate to `/`. */
	onOpenApp?: () => void;
	/** Test overrides for pairing dependencies. */
	overrides?: {
		url?: string;
		origin?: string;
		storage?: PairingStorage;
		randomBytes?: (size: number) => Uint8Array;
		getPairingInfo?: (secret: string) => Promise<RemotePairingInfo>;
		pair?: (
			secret: string,
			addressId: string,
			requestId: string,
		) => Promise<{ token: string; expiresAtMs: number }>;
		loadToken?: () => Promise<string | null>;
		saveToken?: (token: string) => Promise<void>;
		verifyToken?: (token: string) => Promise<void>;
		navigate?: (url: string, options?: { replace?: boolean }) => void;
	};
}

export function RemotePairingPage(props: RemotePairingPageProps) {
	const overrides = props.overrides;
	const origin = overrides?.origin ?? resolvePageOrigin();
	const storage = overrides?.storage ?? browserSessionStorage();
	const randomBytes = overrides?.randomBytes ?? browserRandomBytes;
	const getInfo =
		overrides?.getPairingInfo ??
		((secret: string) => getRemotePairingInfo(secret, origin));
	const pair =
		overrides?.pair ??
		((secret: string, addressId: string, requestId: string) =>
			pairRemote(secret, addressId, requestId, origin));
	const loadToken = overrides?.loadToken ?? loadRemoteDeviceToken;
	const saveToken = overrides?.saveToken ?? saveRemoteDeviceToken;
	const verifyToken =
		overrides?.verifyToken ?? ((tok: string) => verifyRemoteToken(tok, origin));
	const navigate = overrides?.navigate ?? navigateToUrl;

	const initialBoot = capturePairingBootFromUrl(
		overrides?.url ?? resolveCurrentPageUrl(),
		storage,
		(pathname) => {
			try {
				UrlScheme.setUrl(new URL(pathname, origin).href, {
					history: "replace",
				});
			} catch {
				// Ignore if the host rejects URL mutation.
			}
		},
	);

	const boot = signal<PairingBoot>(initialBoot);
	const info = signal<RemotePairingInfo | null>(null);
	const busy = signal(Boolean(initialBoot.context));
	const failure = signal<Failure | null>(
		initialBoot.error ? classifyFailure(new Error(initialBoot.error)) : null,
	);
	const authorized = signal(false);
	const generation = signal(0);

	const openWorkspace = (pairedToken?: string) => {
		if (pairedToken && props.onPaired) {
			try {
				UrlScheme.setUrl(new URL("/", origin).href, { history: "replace" });
			} catch {
				// Ignore URL replacement failures outside browsers.
			}
			props.onPaired(pairedToken);
			return;
		}
		if (props.onOpenApp) {
			try {
				UrlScheme.setUrl(new URL("/", origin).href, { history: "replace" });
			} catch {
				// Ignore URL replacement failures outside browsers.
			}
			props.onOpenApp();
			return;
		}
		navigate(new URL("/", origin).href, { replace: true });
	};

	effect(() => {
		const currentBoot = boot();
		generation();
		const context = currentBoot.context;
		if (!context) return;

		let cancelled = false;
		untracked(() => {
			busy.set(true);
			failure.set(null);
		});

		void (async () => {
			const nextInfo = await getInfo(context.secret);
			if (cancelled) return;
			const entry =
				nextInfo.addresses.find(
					(address) => address.id === context.entryAddressId,
				) ?? nextInfo.addresses.find((address) => address.baseUrl === origin);
			if (!entry || nextInfo.expiresAtMs <= Date.now()) {
				throw new RemotePairingError(401, "invalid or expired pairing link");
			}
			const target =
				pairingTargetAddress(
					nextInfo.addresses,
					context.addressId,
					currentBoot.target,
					origin,
				) ?? nextInfo.addresses.find((address) => address.baseUrl === origin);
			const nextContext = refreshPairingContext(storage, {
				...context,
				addressId: target?.id ?? context.addressId,
				entryAddressId: entry.id,
				expiresAtMs: nextInfo.expiresAtMs,
			});
			info.set(nextInfo);
			if (!target) return;
			const autoOpen = nextInfo.addresses.length === 1;
			const storedToken = await loadToken();
			if (storedToken) {
				try {
					await verifyToken(storedToken);
					if (!cancelled) {
						authorized.set(true);
						if (autoOpen) openWorkspace(storedToken);
					}
					return;
				} catch (error) {
					if (
						!(error instanceof Error) ||
						error.message !== "REMOTE_AUTH_EXPIRED"
					) {
						throw error;
					}
					if (cancelled) return;
					authorized.set(false);
				}
			}
			if (cancelled) return;
			const request = preparePairingRequest(storage, nextContext, randomBytes);
			const result = await pair(request.secret, target.id, request.requestId);
			if (cancelled) return;
			await saveToken(result.token);
			info.update((current) =>
				current
					? {
							...current,
							addresses: current.addresses.map((address) =>
								address.id === target.id
									? { ...address, issued: true }
									: address,
							),
						}
					: current,
			);
			authorized.set(true);
			if (autoOpen) openWorkspace(result.token);
		})()
			.catch((error: unknown) => {
				if (cancelled) return;
				const reason = classifyFailure(error);
				failure.set(reason);
				if (reason === "expired") {
					clearPairingContext(storage);
					boot.update((current) => ({ ...current, context: null }));
				}
			})
			.finally(() => {
				if (!cancelled) busy.set(false);
			});

		cleanup(() => {
			cancelled = true;
		});
	});

	// Allow an already-paired device that scanned an expired link to return to Pilo.
	effect(() => {
		if (authorized() || boot().context) return;
		let cancelled = false;
		void (async () => {
			const storedToken = await loadToken();
			if (!storedToken || cancelled) return;
			try {
				await verifyToken(storedToken);
				if (!cancelled) authorized.set(true);
			} catch {
				// Keep unauthorized when the saved token is expired or unreachable.
			}
		})();
		cleanup(() => {
			cancelled = true;
		});
	});

	// Expire the pairing session on the client once its deadline passes.
	const expiresAtMs = computed(
		() => info()?.expiresAtMs ?? boot().context?.expiresAtMs,
	);
	effect(() => {
		const context = boot().context;
		const deadline = expiresAtMs();
		if (!context || deadline === undefined) return;
		const timer = setTimeout(
			() => {
				clearPairingContext(storage);
				boot.update((current) => ({ ...current, context: null }));
				failure.set("expired");
				busy.set(false);
			},
			Math.max(0, deadline - Date.now()),
		);
		cleanup(() => clearTimeout(timer));
	});

	// Refresh pairing state when returning to foreground or coming back online.
	let wasBackground = false;
	effect(() => {
		const state = lifecycle();
		if (state === "background") {
			wasBackground = true;
			return;
		}
		if (state === "active" && wasBackground) {
			wasBackground = false;
			if (untracked(() => boot().context)) {
				untracked(() => generation.update((n) => n + 1));
			}
		}
	});
	const win = globalThis as unknown as {
		addEventListener?: (type: string, listener: () => void) => void;
		removeEventListener?: (type: string, listener: () => void) => void;
	};
	if (win.addEventListener && win.removeEventListener) {
		const handleOnline = () => {
			if (boot().context) generation.update((n) => n + 1);
		};
		win.addEventListener("online", handleOnline);
		cleanup(() => win.removeEventListener?.("online", handleOnline));
	}

	const entry = computed(() => {
		const currentInfo = info();
		const context = boot().context;
		if (!currentInfo) return undefined;
		return (
			currentInfo.addresses.find(
				(address) => address.id === context?.entryAddressId,
			) ?? currentInfo.addresses.find((address) => address.baseUrl === origin)
		);
	});

	const errorMessage = computed(() => {
		switch (failure()) {
			case "expired":
				return t("settings.remotePairingExpiredDescription");
			case "used":
				return t("settings.remotePairingAddressUsed");
			case "storage":
				return t("settings.remotePairingStorageUnavailable");
			case "random":
				return t("settings.remotePairingRandomUnavailable");
			case "invalid":
				return t("settings.remotePairingInvalidLink");
			case "network":
				return t("settings.remotePairingNetworkError");
			default:
				return null;
		}
	});

	const showCompactConnecting = computed(() => {
		const currentInfo = info();
		return (
			!failure() &&
			(busy() || authorized()) &&
			(!currentInfo || currentInfo.addresses.length === 1)
		);
	});

	return (
		<View
			testID="remote-pairing-page"
			class="flex-1 bg-background"
			style={{
				paddingTop: Math.max(24, safeArea().top + 16),
				paddingBottom: Math.max(24, safeArea().bottom + 16),
				paddingLeft: Math.max(16, safeArea().left + 16),
				paddingRight: Math.max(16, safeArea().right + 16),
			}}
		>
			{() => {
				if (showCompactConnecting()) {
					return (
						<View class="flex-1 items-center justify-center">
							<View
								testID="remote-pairing-connecting"
								class="flex-row items-center gap-2"
							>
								<Spinner size={16} color={token("muted-foreground")} />
								<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-muted-foreground">
									{() => t("settings.remoteConnecting")}
								</Text>
							</View>
						</View>
					);
				}

				const currentBoot = boot();
				const currentInfo = info();
				const currentEntry = entry();
				const currentError = errorMessage();

				return (
					<Scroll
						class="flex-1"
						contentClass="grow items-center justify-center py-4"
						bounces={false}
					>
						<View
							class="w-full max-w-lg gap-5 rounded-2xl border border-border bg-card p-6"
							style={{ boxShadow: styleVar("pilo-shadow-sm") }}
						>
							<View class="gap-2">
								<Icon
									name="ShieldCheck"
									size={28}
									color={token("muted-foreground")}
								/>
								<Text class="font-sans text-lg text-(length:--pilo-ui-text-lg) leading-snug font-semibold text-foreground">
									{() => t("settings.remotePairingPageTitle")}
								</Text>
								<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-normal text-muted-foreground">
									{() => t("settings.remotePairingPageHint")}
								</Text>
							</View>

							{busy() ? (
								<View class="flex-row items-center gap-2">
									<Spinner size={16} color={token("muted-foreground")} />
									<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-muted-foreground">
										{() => t("settings.remoteConnecting")}
									</Text>
								</View>
							) : null}

							{authorized() ? (
								<View testID="remote-pairing-complete" class="gap-2">
									<View class="flex-row items-center gap-2">
										<Icon
											name="CheckCircle2"
											size={20}
											color={token("status-success")}
										/>
										<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight font-medium text-foreground">
											{() => t("settings.remotePairingComplete")}
										</Text>
									</View>
									<Text class="font-mono text-xs text-(length:--pilo-ui-text-xs) leading-snug text-muted-foreground">
										{origin}
									</Text>
								</View>
							) : null}

							{currentError ? (
								<View
									testID="remote-pairing-error"
									role="alert"
									class="rounded-lg border border-border bg-muted/50 p-3"
								>
									<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-normal text-foreground">
										{currentError}
									</Text>
								</View>
							) : null}

							{!currentBoot.context && !failure() ? (
								<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-normal text-muted-foreground">
									{() => t("settings.remotePairRequired")}
								</Text>
							) : null}

							{!currentBoot.target && currentInfo ? (
								<View testID="remote-pairing-addresses" class="gap-3">
									{sortRemoteAddresses(currentInfo.addresses).map((address) => {
										const href =
											currentBoot.context && currentEntry
												? pairingTargetUrl(
														address,
														currentBoot.context,
														currentEntry.id,
													)
												: address.baseUrl;
										return (
											<BaseButton
												testID={`remote-pairing-address:${address.id}`}
												class="min-h-14 flex-row items-center justify-between gap-3 rounded-xl border border-border px-3 py-3 hover:bg-hover active:bg-hover"
												onPress={() => navigate(href)}
											>
												<View class="min-w-0 flex-1 gap-1">
													<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight font-medium text-foreground">
														{address.baseUrl}
													</Text>
													{address.issued ? (
														<Text class="font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-muted-foreground">
															{() => t("settings.remotePairingIssued")}
														</Text>
													) : null}
												</View>
												<Icon
													name="ExternalLink"
													size={16}
													color={token("muted-foreground")}
												/>
											</BaseButton>
										);
									})}
								</View>
							) : null}

							<View class="flex-row flex-wrap gap-2">
								{failure() && currentBoot.context ? (
									<Button
										testID="remote-pairing-retry"
										class="min-h-11 px-4"
										disabled={busy()}
										onPress={() => generation.update((n) => n + 1)}
									>
										<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight font-medium">
											{() => t("common.retry")}
										</Text>
									</Button>
								) : null}

								{currentBoot.target && currentEntry ? (
									<Button
										testID="remote-pairing-continue"
										variant="outline"
										class="min-h-11 px-4"
										onPress={() => navigate(pairingReturnUrl(currentEntry))}
									>
										<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight text-foreground">
											{() => t("settings.remotePairingContinue")}
										</Text>
									</Button>
								) : null}

								{authorized() ? (
									<Button
										testID="remote-pairing-open"
										variant="default"
										class="min-h-11 px-4"
										onPress={() => openWorkspace()}
									>
										<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight font-medium">
											{() => t("settings.remoteOpenPilo")}
										</Text>
									</Button>
								) : null}
							</View>
						</View>
					</Scroll>
				);
			}}
		</View>
	);
}
