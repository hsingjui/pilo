import { cleanup, type Signal, signal, Text, View } from "nsh";

import { userErrorMessage } from "@shared/app-error";
import type { RemotePairingInfo } from "@shared/remote-pairing";
import {
	desktopDeviceName,
	parseDesktopPairingLink,
	type DesktopPairingLink,
	type RemoteHostProxy,
} from "@shared/remote-hosts";
import { t } from "../shell/i18n";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogDescription } from "../ui/dialog-description";
import { DialogFooter } from "../ui/dialog-footer";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import type { HostRegistry } from "./host-registry";
import {
	createDesktopPairingRequestId,
	pairDesktop,
	readDesktopPairingInfo,
	testDesktopProxy,
} from "./remote-pairing-client";

export function remoteProxyError(error: unknown): string | null {
	switch (userErrorMessage(error)) {
		case "REMOTE_PROXY_INVALID_URL":
			return t("hosts.proxyInvalidUrl");
		case "REMOTE_PROXY_NO_ROUTE":
			return t("hosts.proxyNoRoute");
		case "REMOTE_PROXY_SYSTEM_FAILED":
			return t("hosts.proxySystemFailed");
		case "REMOTE_PROXY_AUTH_FAILED":
			return t("hosts.proxyAuthFailed");
		case "REMOTE_PROXY_CREDENTIALS_FAILED":
			return t("hosts.proxyCredentialsFailed");
		case "REMOTE_PROXY_REQUEST_FAILED":
			return t("hosts.proxyRequestFailed");
		case "REMOTE_PROXY_NOT_PILO":
			return t("hosts.proxyNotPilo");
		default:
			return null;
	}
}

/** Pairs this desktop with another machine's Pilo from a pasted pairing link. */
export function AddRemoteHostDialog(props: {
	open: Signal<boolean>;
	registry: HostRegistry;
	machineName: () => string | null;
	onPaired: (name: string) => void;
}) {
	const link = signal("");
	const parsed = signal<DesktopPairingLink | null>(null);
	const info = signal<RemotePairingInfo | null>(null);
	const addressId = signal<string | null>(null);
	const busy = signal(false);
	const error = signal<string | null>(null);
	const proxyMode = signal<"direct" | RemoteHostProxy["mode"]>("direct");
	const proxyUrl = signal("");
	const testingProxy = signal(false);
	const proxyTestResult = signal<{ error: string | null } | null>(null);
	const locked = () => busy() || testingProxy();
	const usesProxy = () => proxyMode() !== "direct";
	const proxy = (): RemoteHostProxy | undefined => {
		const mode = proxyMode();
		if (mode === "custom") return { mode, url: proxyUrl().trim() };
		if (mode === "system") return { mode };
		return undefined;
	};
	// Keep the original proof so a lost response does not strand an issued token.
	const requestIds = new Map<string, string>();
	let version = 0;
	cleanup(() => {
		version += 1;
	});

	const clearPairingInfo = () => {
		parsed.set(null);
		info.set(null);
		addressId.set(null);
		error.set(null);
		proxyTestResult.set(null);
	};
	const reset = () => {
		version += 1;
		requestIds.clear();
		link.set("");
		proxyMode.set("direct");
		proxyUrl.set("");
		busy.set(false);
		testingProxy.set(false);
		clearPairingInfo();
	};
	const selected = () =>
		info()?.addresses.find((address) => address.id === addressId()) ?? null;

	const testProxy = async () => {
		const config = proxy();
		if (!config || locked()) return;
		let origin: string;
		try {
			origin =
				selected()?.baseUrl ?? parseDesktopPairingLink(link()).entryOrigin;
		} catch {
			proxyTestResult.set({ error: t("hosts.invalidLink") });
			return;
		}
		const current = ++version;
		proxyTestResult.set(null);
		testingProxy.set(true);
		try {
			await testDesktopProxy(origin, props.registry.network(config).fetch);
			if (current === version) proxyTestResult.set({ error: null });
		} catch (caught) {
			if (current === version)
				proxyTestResult.set({
					error: remoteProxyError(caught) ?? t("hosts.proxyRequestFailed"),
				});
		} finally {
			if (current === version) testingProxy.set(false);
		}
	};

	const pairingError = (caught: unknown) =>
		`${t("hosts.pairFailed")}: ${remoteProxyError(caught) ?? userErrorMessage(caught)}`;

	const read = async () => {
		if (locked()) return;
		let next: DesktopPairingLink;
		try {
			next = parseDesktopPairingLink(link());
		} catch {
			error.set(t("hosts.invalidLink"));
			return;
		}
		const current = ++version;
		busy.set(true);
		error.set(null);
		try {
			const offered = await readDesktopPairingInfo(
				next,
				props.registry.network(proxy()).fetch,
			);
			if (current !== version) return;
			parsed.set(next);
			info.set(offered);
			const entry =
				offered.addresses.find(({ id }) => id === next.addressId) ??
				offered.addresses.find(({ baseUrl }) => baseUrl === next.entryOrigin) ??
				offered.addresses[0];
			addressId.set(entry?.id ?? null);
			if (entry?.baseUrl !== next.entryOrigin) proxyTestResult.set(null);
		} catch (caught) {
			if (current === version) error.set(pairingError(caught));
		} finally {
			if (current === version) busy.set(false);
		}
	};

	const pair = async () => {
		const target = selected();
		const pairingLink = parsed();
		const offered = info();
		if (locked() || !target || !pairingLink || !offered) return;
		const config = proxy();
		const current = ++version;
		busy.set(true);
		error.set(null);
		try {
			const requestId =
				requestIds.get(target.id) ?? createDesktopPairingRequestId();
			requestIds.set(target.id, requestId);
			const paired = await pairDesktop(
				pairingLink,
				target,
				desktopDeviceName(props.machineName()),
				requestId,
				props.registry.network(config).fetch,
			);
			const record = await props.registry.addPaired({
				addresses: offered.addresses,
				preferredAddressId: target.id,
				token: paired.token,
				deviceId: paired.deviceId,
				scopes: paired.scopes,
				proxy: config,
			});
			if (current !== version) return;
			props.onPaired(record.name);
			props.open.set(false);
			reset();
		} catch (caught) {
			if (current === version) error.set(pairingError(caught));
		} finally {
			if (current === version) busy.set(false);
		}
	};

	return (
		<Dialog
			testID="add-remote-host-dialog"
			open={props.open()}
			accessibilityLabel={t("hosts.addRemote")}
			onOpenChange={({ open }) => {
				props.open.set(open);
				if (!open) reset();
			}}
		>
			<DialogHeader>
				<DialogTitle>{() => t("hosts.addRemote")}</DialogTitle>
				<DialogDescription>
					{() => t("hosts.addRemoteDescription")}
				</DialogDescription>
			</DialogHeader>
			<View class="gap-1.5">
				<Text class="font-sans text-xs font-medium text-muted-foreground">
					{() => t("hosts.pairingLink")}
				</Text>
				<Input
					testID="add-remote-host-link"
					placeholder="http://192.168.1.2:7890/pair#pair=…"
					value={link()}
					disabled={locked()}
					onChange={(event) => {
						requestIds.clear();
						link.set(event.value);
						clearPairingInfo();
					}}
					onSubmit={() => void read()}
				/>
			</View>
			<View class="gap-1.5">
				<Text class="font-sans text-xs font-medium text-muted-foreground">
					{() => t("hosts.proxy")}
				</Text>
				<View class="flex-row items-center gap-2">
					<Select
						class="flex-1"
						size="sm"
						testID="add-remote-host-proxy"
						accessibilityLabel={t("hosts.proxy")}
						items={[
							{ value: "direct", title: t("hosts.proxyDirect") },
							{ value: "system", title: t("hosts.proxySystem") },
							{ value: "custom", title: t("hosts.proxyCustom") },
						]}
						value={proxyMode()}
						disabled={locked()}
						onChange={({ value }) => {
							const mode =
								value === "system" || value === "custom" ? value : "direct";
							if (mode === proxyMode()) return;
							proxyMode.set(mode);
							clearPairingInfo();
						}}
					/>
					{() =>
						usesProxy() ? (
							<Button
								class="shrink-0"
								variant="outline"
								size="sm"
								testID="add-remote-host-test-proxy"
								disabled={locked() || !link().trim()}
								onPress={() => void testProxy()}
							>
								<Text class="font-sans text-xs">
									{() =>
										t(testingProxy() ? "hosts.proxyTesting" : "hosts.proxyTest")
									}
								</Text>
							</Button>
						) : null
					}
				</View>
				{() =>
					proxyMode() === "custom" ? (
						<Input
							testID="add-remote-host-proxy-url"
							accessibilityLabel={t("hosts.proxyUrl")}
							placeholder="http://user:password@proxy.example:8080"
							value={proxyUrl()}
							masked
							autoComplete="off"
							disabled={locked()}
							onChange={({ value }) => {
								proxyUrl.set(value);
								clearPairingInfo();
							}}
						/>
					) : null
				}
				{() => {
					const result = proxyTestResult();
					return usesProxy() && result ? (
						<Text
							class={
								result.error
									? "font-sans text-xs text-status-danger"
									: "font-sans text-xs text-status-success"
							}
						>
							{result.error ?? t("hosts.proxyTestPassed")}
						</Text>
					) : null;
				}}
			</View>
			{() => {
				const offered = info();
				if (!offered) return null;
				return (
					<View class="gap-1.5">
						<Text class="font-sans text-xs font-medium text-muted-foreground">
							{() => t("hosts.address")}
						</Text>
						<Select
							size="sm"
							testID="add-remote-host-address"
							items={offered.addresses.map((address) => ({
								value: address.id,
								title: address.name
									? `${address.name} · ${address.baseUrl}`
									: address.baseUrl,
							}))}
							value={addressId() ?? undefined}
							disabled={locked()}
							onChange={(event) => {
								addressId.set(event.value ?? null);
								proxyTestResult.set(null);
							}}
						/>
					</View>
				);
			}}
			{() =>
				error() ? (
					<Text
						testID="add-remote-host-error"
						class="font-sans text-xs text-status-danger"
					>
						{() => error()}
					</Text>
				) : null
			}
			<DialogFooter>
				<Button
					variant="ghost"
					onPress={() => {
						props.open.set(false);
						reset();
					}}
				>
					<Text class="font-sans">{() => t("common.cancel")}</Text>
				</Button>
				{() =>
					info() ? (
						<Button
							testID="add-remote-host-pair"
							disabled={locked() || !selected()}
							onPress={() => void pair()}
						>
							<Text class="font-sans">
								{() =>
									busy()
										? t("hosts.pairing")
										: requestIds.has(addressId() ?? "")
											? t("common.retry")
											: t("hosts.pair")
								}
							</Text>
						</Button>
					) : (
						<Button
							testID="add-remote-host-read"
							disabled={locked() || !link().trim()}
							onPress={() => void read()}
						>
							<Text class="font-sans">
								{() => t(busy() ? "hosts.reading" : "hosts.readLink")}
							</Text>
						</Button>
					)
				}
			</DialogFooter>
		</Dialog>
	);
}
