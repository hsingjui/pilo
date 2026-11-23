import { type Accessor, Canvas, computed, Path2D, Text, View } from "nsh";

import { t } from "../app/i18n";
import { qrMatrix } from "../lib/qr-matrix";
import { Icon } from "../ui/icon";
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

export function RemotePairingSection(props: {
	hasLink: Accessor<boolean>;
	url: Accessor<string | null>;
	regenerating: Accessor<boolean>;
	onCopy: () => void;
	onRegenerate: () => void;
}) {
	const wide = () => !isNarrowSettings();
	return (
		<SettingsSection title={t("settings.remotePairing")}>
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
							<View
								testID="remote-pairing-url"
								class="truncate rounded-md border border-border bg-muted/30 px-2.5 py-1.5"
							>
								<Text class="truncate font-mono text-[10px] leading-5">
									{() => props.url()}
								</Text>
							</View>
							<View class="flex-row flex-wrap gap-1.5">
								<SettingsActionButton
									variant="outline"
									testID="remote-pairing-copy"
									onPress={props.onCopy}
								>
									<Icon name="Copy" size={14} />
									<Text class="font-sans text-xs">
										{t("settings.remoteCopyLink")}
									</Text>
								</SettingsActionButton>
								<SettingsActionButton
									testID="remote-pairing-regenerate"
									disabled={props.regenerating()}
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
							disabled={props.regenerating()}
							onPress={props.onRegenerate}
						>
							<Icon name="RefreshCw" size={14} />
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
