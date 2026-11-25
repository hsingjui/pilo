import { signal, Text, View } from "nsh";

import type { Connection } from "@shared/api/pi-runtime-types";
import { userErrorMessage } from "@shared/app-error";
import { AppToasts, AppToastStack } from "../shell/app-toasts";
import { connectionLabel } from "../shell/connection-label";
import { t } from "../shell/i18n";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogClose } from "../ui/dialog-close";
import { DialogFooter } from "../ui/dialog-footer";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { useMountedDialog } from "../ui/motion";
import { Input } from "../ui/input";
import { Spinner } from "../ui/spinner";
import { field } from "./connection-form";
import type { ConfigureDraft } from "./ssh-connection-draft";
import type { ConnectionsClient } from "./connections-pane";

/**
 * The "name + Pi path" editor shared by local, WSL and SSH connections.
 * The draft stays a plain object for the same reason as the SSH editor's.
 */
export function createConfigureDialog(deps: {
	client: ConnectionsClient;
	refresh: () => Promise<void>;
	toasts: AppToasts;
}) {
	const client = deps.client;
	let configureDraft: ConfigureDraft | null = null;
	const open = signal(false);
	/** Re-read the draft for the footer state. */
	const formRev = signal(0);
	/** Re-read the draft for the probed Pi path. */
	const piRev = signal(0);
	const probing = signal(false);
	const busy = signal(false);

	const openSettings = (connection: Connection) => {
		configureDraft = {
			connection,
			name: connection.name,
			piExecutable: connection.piExecutable ?? "",
		};
		open.set(true);
	};

	const close = () => {
		configureDraft = null;
		open.set(false);
	};

	const save = async (toasts: AppToasts) => {
		const draft = configureDraft;
		if (!draft?.name.trim()) return;
		busy.set(true);
		try {
			await client.updateConnectionSettings(
				draft.connection.id,
				draft.name.trim(),
				draft.piExecutable.trim() || null,
			);
			close();
			await deps.refresh();
			deps.toasts.show({
				variant: "success",
				title: t("connection.connectionSaved"),
			});
		} catch (caught) {
			(configureDraft === draft ? toasts : deps.toasts).show({
				variant: "error",
				title: t("connection.saveFailed"),
				description: userErrorMessage(caught),
			});
		} finally {
			busy.set(false);
		}
	};

	const probePi = async (toasts: AppToasts) => {
		const draft = configureDraft;
		if (!draft) return;
		probing.set(true);
		try {
			const info = await client.probeConnectionPi(
				draft.connection.id,
				draft.piExecutable.trim() || null,
			);
			if (configureDraft?.connection.id === draft.connection.id) {
				configureDraft.piExecutable = info.executable;
				piRev.update((n) => n + 1);
			}
			toasts.show({
				variant: "success",
				title: t("connection.piAvailable", {
					name: connectionLabel(draft.connection),
				}),
				description: [info.executable, info.version]
					.filter(Boolean)
					.join(" · "),
			});
		} catch (caught) {
			toasts.show({
				variant: "error",
				title: t("connection.piUnavailable", {
					name: connectionLabel(draft.connection),
				}),
				description: userErrorMessage(caught),
			});
		} finally {
			probing.set(false);
		}
	};

	return {
		draft: () => configureDraft,
		open,
		formRev,
		piRev,
		probing,
		busy,
		openSettings,
		close,
		save,
		probePi,
	};
}

export type ConfigureDialog = ReturnType<typeof createConfigureDialog>;

export function ConfigureConnectionDialog(props: { dialog: ConfigureDialog }) {
	const dialog = props.dialog;
	const mounted = useMountedDialog(dialog.open);
	return (
		<Dialog
			testID="settings-conn-configure"
			open={dialog.open()}
			accessibilityLabel={t("connection.configureTitle")}
			class="max-w-md"
			onOpenChange={({ open }) => {
				if (!open) dialog.close();
			}}
			onClose={mounted.onClose}
		>
			{() => {
				const draft = mounted.mounted() ? dialog.draft() : null;
				if (!draft) return null;
				const toasts = new AppToasts();
				const usesLocalPi =
					draft.connection.kind.type === "ssh" &&
					draft.connection.piRuntime === "local";
				return (
					<>
						<DialogHeader>
							<DialogTitle>{t("connection.configureTitle")}</DialogTitle>
						</DialogHeader>
						{field(
							t("connection.name"),
							<Input
								size="sm"
								testID="settings-conn-name"
								value={draft.name}
								onChange={(event) => {
									draft.name = event.value;
									dialog.formRev.update((n) => n + 1);
								}}
							/>,
						)}
						{() => {
							void dialog.piRev();
							const probing = dialog.probing();
							const disabled = dialog.busy() || probing;
							return usesLocalPi
								? field(
										t("connection.runtimeLocation"),
										<View class="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5">
											<Text class="font-sans text-[11px] text-muted-foreground">
												{t("connection.localPi")}
											</Text>
										</View>,
									)
								: field(
										t("connection.piPath"),
										<View class="flex-row gap-2">
											<Input
												size="sm"
												testID="settings-conn-pi"
												class="flex-1 font-mono"
												value={draft.piExecutable}
												placeholder={String(t("connection.autoDetect"))}
												onChange={(event) => {
													draft.piExecutable = event.value;
													dialog.formRev.update((n) => n + 1);
												}}
											/>
											<Button
												testID="settings-conn-probe"
												variant="outline"
												size="sm"
												class="shrink-0"
												accessibilityLabel={
													probing
														? t("connection.detecting")
														: t("connection.detectPi")
												}
												disabled={disabled}
												onPress={() => void dialog.probePi(toasts)}
											>
												<View class="relative items-center justify-center">
													<Text
														class={
															probing ? "font-sans invisible" : "font-sans"
														}
													>
														{t("connection.detectPi")}
													</Text>
													{probing ? (
														<View class="absolute inset-0 items-center justify-center">
															<Spinner size={14} />
														</View>
													) : null}
												</View>
											</Button>
										</View>,
									);
						}}
						{() => {
							void dialog.formRev();
							return (
								<DialogFooter>
									<Button
										testID="settings-conn-cancel"
										variant="outline"
										size="sm"
										disabled={dialog.busy()}
										onPress={() => dialog.close()}
									>
										<Text class="font-sans">{t("common.cancel")}</Text>
									</Button>
									<Button
										testID="settings-conn-save"
										size="sm"
										disabled={dialog.busy() || !draft.name.trim()}
										onPress={() => void dialog.save(toasts)}
									>
										<Text class="font-sans">
											{dialog.busy() ? t("common.saving") : t("common.save")}
										</Text>
									</Button>
								</DialogFooter>
							);
						}}
						<DialogClose
							accessibilityLabel={t("common.close")}
							onPress={() => dialog.close()}
						/>
						<AppToastStack toasts={toasts} />
					</>
				);
			}}
		</Dialog>
	);
}
