import {
	type Accessor,
	Canvas,
	computed,
	OffscreenCanvas,
	Path2D,
	signal,
	Text,
	token,
	View,
} from "nsh";

import type { RemoteAccessAddress } from "@shared/api/remote-types";
import { t } from "../shell/i18n";
import { qrMatrix } from "../lib/qr-matrix";
import { CopyStatusIcon } from "../ui/copy-status-icon";
import { Icon } from "../ui/icon";
import { Select } from "../ui/select";
import { Spinner } from "../ui/spinner";
import {
	isNarrowSettings,
	SettingsActionButton,
	SettingsRow,
	SettingsSection,
} from "./layout";

/** The pairing link's QR code, drawn like `<QRCodeSVG level="M">`. */
function PairingQr(props: { url: string; size: number }) {
	const matrix = computed(() => qrMatrix(props.url));
	return (
		<Canvas
			testID="remote-pairing-qr"
			accessibilityLabel={t("settings.remotePairing")}
			accessible
			style={{ width: props.size, height: props.size }}
			draw={(cx, size) => {
				const modules = matrix();
				const scale = Math.min(size.width, size.height) / modules.length;
				cx.fillStyle = "#ffffff";
				cx.fillRect(0, 0, size.width, size.height);
				cx.fillStyle = "#000000";
				const path = new Path2D();
				for (let y = 0; y < modules.length; y++)
					for (let x = 0; x < modules.length; x++)
						if (modules[y][x])
							path.rect(x * scale, y * scale, scale + 0.5, scale + 0.5);
				cx.fill(path);
			}}
		/>
	);
}

const PAIRING_URL_FONT_SIZE = 10;

function PairingUrl(props: { url: Accessor<string | null> }) {
	const width = signal<number | undefined>(undefined);
	const measure = new OffscreenCanvas(1, 1).getContext("2d");
	const displayUrl = computed(() => {
		const url = props.url() ?? "";
		const available = width();
		if (available === undefined || !url) return url;

		measure.font = `${PAIRING_URL_FONT_SIZE}px ${token("font-mono") ?? "monospace"}`;
		if (measure.measureText(url).width <= available) return url;

		// Fit the longest URL prefix, rather than breaking at a word boundary.
		let low = 0;
		let high = url.length - 1;
		while (low < high) {
			const mid = Math.ceil((low + high) / 2);
			if (measure.measureText(`${url.slice(0, mid)}…`).width <= available)
				low = mid;
			else high = mid - 1;
		}
		return `${url.slice(0, low)}…`;
	});

	return (
		<View
			testID="remote-pairing-url"
			class="flex-row overflow-hidden rounded-md border border-border bg-muted/30 px-2.5 py-1.5"
		>
			<Text
				class="min-w-0 flex-1 whitespace-nowrap font-mono leading-5"
				style={{ fontSize: PAIRING_URL_FONT_SIZE }}
				accessibilityLabel={props.url() ?? undefined}
				onLayout={({ bounds }) => width.set(bounds.size.width)}
			>
				{displayUrl}
			</Text>
		</View>
	);
}

export function RemotePairingSection(props: {
	addresses: Accessor<RemoteAccessAddress[]>;
	entryAddressId: Accessor<string>;
	onSelectEntry: (id: string | null) => void;
	hasLink: Accessor<boolean>;
	url: Accessor<string | null>;
	regenerating: Accessor<boolean>;
	disabled: Accessor<boolean>;
	copied?: Accessor<boolean>;
	onCopy: () => void;
	onRegenerate: () => void;
}) {
	const wide = () => !isNarrowSettings();
	const hasAddressChoices = computed(() => props.addresses().length > 1);
	return (
		<SettingsSection title={t("settings.remotePairing")}>
			{() =>
				hasAddressChoices() ? (
					<SettingsRow label={t("settings.remotePairingEntryAddress")}>
						<Select
							size="sm"
							class="w-64"
							testID="remote-pairing-entry-address"
							accessibilityLabel={t("settings.remotePairingEntryAddress")}
							items={props.addresses().map((address) => ({
								value: address.id,
								title: address.baseUrl,
							}))}
							value={props.entryAddressId()}
							disabled={props.disabled()}
							onChange={(event) => props.onSelectEntry(event.value)}
						/>
					</SettingsRow>
				) : null
			}
			{() =>
				props.hasLink() ? (
					<View
						class={
							wide()
								? "flex-row items-center gap-3 px-3 py-3"
								: "gap-3 px-3 py-3"
						}
					>
						<View class={wide() ? "min-w-0 flex-1 gap-2" : "min-w-0 gap-2"}>
							<Text class="font-sans text-sm font-medium">
								{t("settings.remoteOpenLink")}
							</Text>
							<Text class="font-sans text-xs text-muted-foreground">
								{t("settings.remotePairingShareWarning")}
							</Text>
							<PairingUrl url={props.url} />
							<View class="flex-row flex-wrap gap-1.5">
								<SettingsActionButton
									variant="outline"
									testID="remote-pairing-copy"
									onPress={props.onCopy}
								>
									<CopyStatusIcon
										copied={() => props.copied?.() ?? false}
										size={14}
									/>
									<Text class="font-sans text-xs">
										{t("settings.remoteCopyLink")}
									</Text>
								</SettingsActionButton>
								<SettingsActionButton
									testID="remote-pairing-regenerate"
									disabled={props.disabled()}
									onPress={props.onRegenerate}
								>
									{() =>
										props.regenerating() ? (
											<Spinner class="size-3.5" />
										) : (
											<Icon name="RefreshCw" size={14} />
										)
									}
									<Text class="font-sans text-xs">
										{t("settings.remoteNewLink")}
									</Text>
								</SettingsActionButton>
							</View>
						</View>
						{/* React's `sm:grid-cols-[minmax(0,1fr)_148px]` column. */}
						<View
							class="items-center"
							style={wide() ? { width: 148 } : undefined}
						>
							<View class="rounded-xl border border-border bg-white p-2.5">
								<PairingQr url={props.url() ?? ""} size={124} />
							</View>
						</View>
					</View>
				) : (
					<SettingsRow
						label={t("settings.remotePairingExpired")}
						helper={t("settings.remotePairingExpiredDescription")}
					>
						<SettingsActionButton
							variant="outline"
							testID="remote-pairing-regenerate"
							disabled={props.disabled()}
							onPress={props.onRegenerate}
						>
							{() =>
								props.regenerating() ? (
									<Spinner class="size-3.5" />
								) : (
									<Icon name="RefreshCw" size={14} />
								)
							}
							<Text class="font-sans text-xs">
								{t("settings.remoteNewLink")}
							</Text>
						</SettingsActionButton>
					</SettingsRow>
				)
			}
		</SettingsSection>
	);
}
