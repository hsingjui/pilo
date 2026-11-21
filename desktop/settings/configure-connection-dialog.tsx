import { signal, Text, View } from "nsh";

import type { Connection } from "@/lib/api/pi-runtime-types";
import { userErrorMessage } from "@/lib/app-error";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogFooter } from "../ui/dialog-footer";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
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
	setResult: (id: string, text: string) => void;
	connectionLabel: (connection: Connection) => string;
}) {
	const client = deps.client;
	let configureDraft: ConfigureDraft | null = null;
	const open = signal(false);
	/** Re-read the draft for the footer state. */
	const formRev = signal(0);
	/** Re-read the draft for the probed Pi path. */
	const piRev = signal(0);
	const probing = signal(false);
	const error = signal<string | null>(null);
	const busy = signal(false);

	const openSettings = (connection: Connection) => {
		error.set(null);
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

	const save = async () => {
		const draft = configureDraft;
		if (!draft?.name.trim()) return;
		busy.set(true);
		error.set(null);
		try {
			await client.updateConnectionSettings(
				draft.connection.id,
				draft.name.trim(),
				draft.piExecutable.trim() || null,
			);
			close();
			await deps.refresh();
			deps.setResult(draft.connection.id, t("connection.connectionSaved"));
		} catch (caught) {
			error.set(`${t("connection.saveFailed")} · ${userErrorMessage(caught)}`);
		} finally {
			busy.set(false);
		}
	};

	const probePi = async () => {
		const draft = configureDraft;
		if (!draft) return;
		probing.set(true);
		error.set(null);
		try {
			const info = await client.probeConnectionPi(
				draft.connection.id,
				draft.piExecutable.trim() || null,
			);
			if (configureDraft?.connection.id === draft.connection.id) {
				configureDraft.piExecutable = info.executable;
				piRev.update((n) => n + 1);
			}
			deps.setResult(
				draft.connection.id,
				`${t("connection.piAvailable", {
					name: deps.connectionLabel(draft.connection),
				})} · ${[info.executable, info.version].filter(Boolean).join(" · ")}`,
			);
		} catch (caught) {
			error.set(
				`${t("connection.piUnavailable", {
					name: deps.connectionLabel(draft.connection),
				})} · ${userErrorMessage(caught)}`,
			);
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
		error,
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
	const draft = dialog.draft();
	if (!draft) return null;
	const usesLocalPi =
		draft.connection.kind.type === "ssh" &&
		draft.connection.piRuntime === "local";
	return (
		<Dialog
			testID="settings-conn-configure"
			open={true}
			accessibilityLabel={t("connection.configureTitle")}
			class="max-w-md"
			onOpenChange={({ open }) => {
				if (!open) dialog.close();
			}}
		>
			<DialogHeader>
				<DialogTitle>{t("connection.configureTitle")}</DialogTitle>
			</DialogHeader>
			{field(
				t("connection.name"),
				<Input
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
				const disabled = dialog.busy() || dialog.probing();
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
									disabled={disabled}
									onPress={() => void dialog.probePi()}
								>
									<Text class="font-sans">
										{dialog.probing()
											? t("connection.detecting")
											: t("connection.detectPi")}
									</Text>
								</Button>
							</View>,
						);
			}}
			{() =>
				dialog.error() ? (
					<Text
						testID="settings-conn-configure-error"
						class="font-sans text-[11px] text-destructive"
					>
						{dialog.error()}
					</Text>
				) : null
			}
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
							onPress={() => void dialog.save()}
						>
							<Text class="font-sans">
								{dialog.busy() ? t("common.saving") : t("common.save")}
							</Text>
						</Button>
					</DialogFooter>
				);
			}}
			<View
				accessibilityLabel={t("common.close")}
				class="absolute right-3 top-3 size-6 items-center justify-center rounded-xs opacity-70 hover:opacity-100"
				onPress={() => dialog.close()}
			>
				<Icon name="X" size={16} />
			</View>
		</Dialog>
	);
}
