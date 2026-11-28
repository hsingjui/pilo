import { Scroll, signal, Text, token, View } from "nsh";

import type { WslDistribution } from "@shared/api/pi-runtime-types";
import { userErrorMessage } from "@shared/app-error";
import { AppToasts, AppToastStack } from "../shell/app-toasts";
import { t } from "../shell/i18n";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogClose } from "../ui/dialog-close";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { useMountedDialog } from "../ui/motion";
import { Icon } from "../ui/icon";
import type { ConnectionsClient } from "./connections-pane";

/** The WSL distro picker's controller: distro list + add flow. */
export function createWslPicker(deps: {
	client: ConnectionsClient;
	refresh: () => Promise<void>;
	toasts: AppToasts;
	addedDistros: () => Set<string>;
	supportsWsl: () => boolean;
}) {
	const client = deps.client;
	const open = signal(false);
	/** `null` until the platform reports the distro list. */
	const distros = signal<WslDistribution[] | null>(null);
	const loadError = signal<string | null>(null);
	const busy = signal(false);
	const loading = signal(false);
	let pickerRevision = 0;
	let loadSeq = 0;

	const loadDistros = () => {
		if (!deps.supportsWsl()) return;
		const seq = ++loadSeq;
		loading.set(true);
		distros.set(null);
		loadError.set(null);
		client
			.listWslDistributions()
			.then((items) => {
				if (seq === loadSeq) distros.set(items);
			})
			.catch((caught) => {
				if (seq === loadSeq) {
					distros.set([]);
					loadError.set(userErrorMessage(caught));
				}
			})
			.finally(() => {
				if (seq === loadSeq) loading.set(false);
			});
	};

	const openPicker = () => {
		pickerRevision += 1;
		open.set(true);
		if (
			deps.supportsWsl() &&
			!loading() &&
			(distros() === null || loadError() !== null)
		) {
			loadDistros();
		}
	};

	const add = async (distro: string, dialogToasts: AppToasts) => {
		if (busy()) return;
		const revision = pickerRevision;
		const toasts = () =>
			open() && revision === pickerRevision ? dialogToasts : deps.toasts;
		busy.set(true);
		try {
			await client.saveWslConnection({
				id: `wsl:${distro}`,
				name: `WSL · ${distro}`,
				kind: { type: "wsl", distro },
			});
			await deps.refresh();
			toasts().show({
				variant: "success",
				title: t("connection.wslAdded", { name: distro }),
			});
		} catch (caught) {
			toasts().show({
				variant: "error",
				title: t("connection.wslAddFailed"),
				description: userErrorMessage(caught),
			});
		} finally {
			busy.set(false);
		}
	};

	return {
		open,
		distros,
		loadError,
		busy,
		openPicker,
		retry: loadDistros,
		add,
		addedDistros: deps.addedDistros,
	};
}

export type WslPicker = ReturnType<typeof createWslPicker>;

export function WslPickerDialog(props: { picker: WslPicker }) {
	const picker = props.picker;
	const mounted = useMountedDialog(picker.open);
	return (
		<Dialog
			testID="settings-wsl-picker"
			open={picker.open()}
			accessibilityLabel={t("connection.addWslTitle")}
			class="max-w-md"
			onOpenChange={({ open }) => {
				if (!open) picker.open.set(false);
			}}
			onClose={mounted.onClose}
		>
			{() => {
				if (!mounted.mounted()) return null;
				const toasts = new AppToasts();
				return (
					<>
						<DialogHeader>
							<DialogTitle>{t("connection.addWslTitle")}</DialogTitle>
						</DialogHeader>
						<Scroll
							class="max-h-72 overflow-hidden rounded-md border border-border/60"
							bounces={false}
						>
							{() => {
								const error = picker.loadError();
								if (error !== null)
									return (
										<View class="items-start gap-2 px-3 py-4">
											<Text class="font-sans text-xs text-destructive">
												{`${t("connection.loadWslFailed")} · ${error}`}
											</Text>
											<Button
												testID="settings-wsl-retry"
												variant="outline"
												size="sm"
												onPress={() => picker.retry()}
											>
												<Text class="font-sans">{t("common.retry")}</Text>
											</Button>
										</View>
									);
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
													onPress={() => void picker.add(distro.name, toasts)}
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
						<AppToastStack toasts={toasts} />
					</>
				);
			}}
		</Dialog>
	);
}
