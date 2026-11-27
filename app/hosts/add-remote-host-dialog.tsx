import { type Signal, signal, Text, View } from "nsh";

import { userErrorMessage } from "@shared/app-error";
import {
	desktopDeviceName,
	isPlaintextRemoteAddress,
	parseDesktopPairingLink,
	type DesktopPairingLink,
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
	pairDesktop,
	readDesktopPairingInfo,
	type DesktopPairingInfo,
} from "./remote-pairing-client";

/** Pairs this desktop with another machine's Pilo from a pasted pairing link. */
export function AddRemoteHostDialog(props: {
	open: Signal<boolean>;
	registry: HostRegistry;
	machineName: () => string | null;
	onPaired: (name: string) => void;
}) {
	const link = signal("");
	const parsed = signal<DesktopPairingLink | null>(null);
	const info = signal<DesktopPairingInfo | null>(null);
	const addressId = signal<string | null>(null);
	const busy = signal(false);
	const error = signal<string | null>(null);
	let version = 0;

	const reset = () => {
		version += 1;
		link.set("");
		parsed.set(null);
		info.set(null);
		addressId.set(null);
		busy.set(false);
		error.set(null);
	};
	const selected = () =>
		info()?.addresses.find((address) => address.id === addressId()) ?? null;

	const read = async () => {
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
			const offered = await readDesktopPairingInfo(next);
			if (current !== version) return;
			parsed.set(next);
			info.set(offered);
			const entry =
				offered.addresses.find(({ id }) => id === next.addressId) ??
				offered.addresses.find(({ baseUrl }) => baseUrl === next.entryOrigin) ??
				offered.addresses[0];
			addressId.set(entry?.id ?? null);
		} catch (caught) {
			if (current === version)
				error.set(`${t("hosts.pairFailed")}: ${userErrorMessage(caught)}`);
		} finally {
			if (current === version) busy.set(false);
		}
	};

	const pair = async () => {
		const target = selected();
		const pairingLink = parsed();
		const offered = info();
		if (!target || !pairingLink || !offered) return;
		const current = ++version;
		busy.set(true);
		error.set(null);
		try {
			const paired = await pairDesktop(
				pairingLink,
				target,
				desktopDeviceName(props.machineName()),
			);
			const record = await props.registry.addPaired({
				addresses: offered.addresses,
				preferredAddressId: target.id,
				token: paired.token,
				deviceId: paired.deviceId,
				scopes: paired.scopes,
			});
			if (current !== version) return;
			props.onPaired(record.name);
			props.open.set(false);
			reset();
		} catch (caught) {
			if (current === version)
				error.set(`${t("hosts.pairFailed")}: ${userErrorMessage(caught)}`);
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
					disabled={busy()}
					onChange={(event) => {
						link.set(event.value);
						parsed.set(null);
						info.set(null);
						error.set(null);
					}}
					onSubmit={() => void read()}
				/>
			</View>
			{() => {
				const offered = info();
				if (!offered) return null;
				const target = selected();
				return (
					<View class="gap-2">
						<View class="gap-1.5">
							<Text class="font-sans text-xs font-medium text-muted-foreground">
								{() => t("hosts.address")}
							</Text>
							<Select
								size="sm"
								testID="add-remote-host-address"
								items={offered.addresses.map((address) => ({
									value: address.id,
									title: `${address.name} · ${address.baseUrl}`,
								}))}
								value={addressId() ?? undefined}
								disabled={busy()}
								onChange={(event) => addressId.set(event.value ?? null)}
							/>
						</View>
						<Text
							testID="add-remote-host-scope"
							class={`font-sans text-xs ${
								offered.scopes === "chat,workspace"
									? "text-status-warning"
									: "text-muted-foreground"
							}`}
						>
							{() =>
								t(
									offered.scopes === "chat,workspace"
										? "hosts.scopeWorkspace"
										: "hosts.scopeChat",
								)
							}
						</Text>
						{target && isPlaintextRemoteAddress(target.baseUrl) ? (
							<Text
								testID="add-remote-host-plaintext"
								class="font-sans text-xs text-status-danger"
							>
								{() => t("hosts.plaintextWarning")}
							</Text>
						) : null}
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
							disabled={busy() || !selected()}
							onPress={() => void pair()}
						>
							<Text class="font-sans">
								{() => (busy() ? t("hosts.pairing") : t("hosts.pair"))}
							</Text>
						</Button>
					) : (
						<Button
							testID="add-remote-host-read"
							disabled={busy() || !link().trim()}
							onPress={() => void read()}
						>
							<Text class="font-sans">
								{() => (busy() ? t("hosts.reading") : t("hosts.readLink"))}
							</Text>
						</Button>
					)
				}
			</DialogFooter>
		</Dialog>
	);
}
