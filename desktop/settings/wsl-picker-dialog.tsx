import { platform, Scroll, signal, Text, token, View } from "nsh";

import type { WslDistribution } from "@shared/api/pi-runtime-types";
import { userErrorMessage } from "@shared/app-error";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogClose } from "../ui/dialog-close";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { Icon } from "../ui/icon";
import type { ConnectionsClient } from "./connections-pane";

const IS_WINDOWS = platform.os === "windows";

/** The WSL distro picker's controller: distro list + add flow. */
export function createWslPicker(deps: {
	client: ConnectionsClient;
	refresh: () => Promise<void>;
	setResult: (id: string, text: string) => void;
	addedDistros: () => Set<string>;
}) {
	const client = deps.client;
	const open = signal(false);
	/** `null` until the platform reports the distro list. */
	const distros = signal<WslDistribution[] | null>(null);
	const busy = signal(false);

	const openPicker = () => {
		open.set(true);
		if (IS_WINDOWS && distros() === null) {
			client
				.listWslDistributions()
				.then((items) => distros.set(items))
				.catch((caught) => {
					distros.set([]);
					deps.setResult(
						"wsl-add",
						`${t("connection.loadWslFailed")} · ${userErrorMessage(caught)}`,
					);
				});
		}
	};

	const add = async (distro: string) => {
		busy.set(true);
		try {
			await client.saveWslConnection({
				id: `wsl:${distro}`,
				name: `WSL · ${distro}`,
				kind: { type: "wsl", distro },
			});
			await deps.refresh();
			deps.setResult(
				`wsl:${distro}`,
				t("connection.wslAdded", { name: distro }),
			);
		} catch (caught) {
			deps.setResult(
				"wsl-add",
				`${t("connection.wslAddFailed")} · ${userErrorMessage(caught)}`,
			);
		} finally {
			busy.set(false);
		}
	};

	return {
		open,
		distros,
		busy,
		openPicker,
		add,
		addedDistros: deps.addedDistros,
	};
}

export type WslPicker = ReturnType<typeof createWslPicker>;

export function WslPickerDialog(props: { picker: WslPicker }) {
	const picker = props.picker;
	return (
		<Dialog
			testID="settings-wsl-picker"
			open={true}
			accessibilityLabel={t("connection.addWslTitle")}
			class="max-w-md"
			onOpenChange={({ open }) => {
				if (!open) picker.open.set(false);
			}}
		>
			<DialogHeader>
				<DialogTitle>{t("connection.addWslTitle")}</DialogTitle>
			</DialogHeader>
			<Scroll
				class="max-h-72 rounded-md border border-border/60"
				bounces={false}
			>
				{() => {
					const items = picker.distros();
					return items === null ? (
						<Text class="font-sans px-3 py-4 text-xs text-muted-foreground">
							{t("connection.loading")}
						</Text>
					) : items.length === 0 ? (
						<Text class="font-sans px-3 py-4 text-xs text-muted-foreground">
							{t("connection.noWsl")}
						</Text>
					) : (
						items.map((distro) => {
							const added = picker.addedDistros().has(distro.name);
							return (
								<View class="flex-row items-center gap-3 border-border/60 border-b px-3 py-2 last:border-b-0">
									<Icon
										name="Monitor"
										size={16}
										color={token("muted-foreground")}
									/>
									<Text class="font-sans min-w-0 flex-1 truncate text-sm">
										{distro.name}
									</Text>
									<Button
										testID={`settings-wsl-add-${distro.name}`}
										variant="outline"
										size="sm"
										disabled={picker.busy() || added}
										onPress={() => void picker.add(distro.name)}
									>
										<Text class="font-sans">
											{added ? t("common.added") : t("common.add")}
										</Text>
									</Button>
								</View>
							);
						})
					);
				}}
			</Scroll>
			<DialogClose
				accessibilityLabel={t("common.close")}
				onPress={() => picker.open.set(false)}
			/>
		</Dialog>
	);
}
