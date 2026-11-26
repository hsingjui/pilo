import { cleanup, signal, Text, View } from "nsh";

import type {
	Connection,
	PiloRuntimeEvent,
} from "@shared/api/pi-runtime-types";
import { userErrorMessage } from "@shared/app-error";
import type { NextPromptSettings } from "@shared/next-prompt-types";
import type { PromptEnhancementSettings } from "@shared/prompt-enhancement-types";
import { AppToaster, showToast } from "../shell/app-toasts";
import { connectionLabel } from "../shell/connection-label";
import { t } from "../shell/i18n";
import { Switch } from "../ui/switch";
import {
	ConnectionModelLists,
	ConnectionModelSelect,
	modelKey,
	paneConnectionCatalog,
	subscribeSettingsEvents,
} from "./connection-settings";
import {
	SettingsActionButton,
	SettingsRow,
	SettingsSection,
	SettingsSectionMessage,
} from "./layout";
import type { SettingsClient } from "./settings-dialog";

type PromptSettings = NextPromptSettings | PromptEnhancementSettings;

/** Per-connection model and toggle for the two prompt features. */
export function ConnectionPromptSettingsPane(props: {
	client: SettingsClient;
	testID: string;
	labelPrefix: "settings.nextPrompt" | "settings.promptEnhancement";
	load: (connectionId: string) => Promise<PromptSettings>;
	save: (
		connectionId: string,
		enabled: boolean,
		model: PromptSettings["model"],
	) => Promise<PromptSettings>;
	readEvent: (event: PiloRuntimeEvent) => PromptSettings | undefined;
}) {
	const toasts = AppToaster();
	const lists = new ConnectionModelLists(props.client);
	const connections = signal<Connection[]>([]);
	const loadingCatalog = signal(true);
	const catalogError = signal<string | null>(null);
	const settings = signal<Record<string, PromptSettings>>({});
	const busy = signal<Record<string, boolean>>({});
	const syncingAll = signal(false);
	const errors = signal<Record<string, string | undefined>>({});
	let alive = true;
	cleanup(() => {
		alive = false;
	});

	const mergeSettings = (next: PromptSettings) => {
		const current = settings()[next.connectionId];
		if (current && current.updatedAtMs > next.updatedAtMs) return;
		settings.set({ ...settings(), [next.connectionId]: next });
	};
	const setError = (connectionId: string, error: string | null) =>
		errors.set({ ...errors(), [connectionId]: error ?? undefined });
	const loadSettings = (connection: Connection) => {
		props
			.load(connection.id)
			.then((next) => {
				if (alive) mergeSettings(next);
			})
			.catch((error: unknown) => {
				if (alive) setError(connection.id, userErrorMessage(error));
			});
	};

	void paneConnectionCatalog(props.client)
		.then((catalog) => {
			if (!alive) return;
			connections.set(catalog);
			for (const connection of catalog) {
				void lists.state(connection.id);
				loadSettings(connection);
			}
		})
		.catch((error: unknown) => {
			if (alive) catalogError.set(userErrorMessage(error));
		})
		.finally(() => {
			if (alive) loadingCatalog.set(false);
		});

	subscribeSettingsEvents(props.client, (event) => {
		const next = props.readEvent(event);
		if (next) mergeSettings(next);
	});

	const anyRowBusy = () => Object.values(busy()).some(Boolean);

	const save = (
		connection: Connection,
		patch: { enabled?: boolean; model?: PromptSettings["model"] },
	) => {
		const connectionId = connection.id;
		if (busy()[connectionId] || syncingAll()) return;
		const current = settings()[connectionId];
		busy.set({ ...busy(), [connectionId]: true });
		props
			.save(
				connectionId,
				patch.enabled ?? current?.enabled ?? false,
				patch.model === undefined ? (current?.model ?? null) : patch.model,
			)
			.then((next) => {
				if (!alive) return;
				mergeSettings(next);
				setError(connectionId, null);
			})
			.catch((error: unknown) => {
				if (alive)
					showToast(toasts, {
						variant: "error",
						title: t("settings.preferencesSaveFailed"),
						description: userErrorMessage(error),
					});
			})
			.finally(() => {
				if (alive) busy.set({ ...busy(), [connectionId]: false });
			});
	};

	const applyToAll = async () => {
		const list = connections();
		const source = list[0] ? settings()[list[0].id] : undefined;
		if (!source || list.length <= 1 || syncingAll() || anyRowBusy()) return;
		syncingAll.set(true);
		try {
			const settled = await Promise.allSettled(
				list
					.slice(1)
					.map((connection) =>
						props.save(connection.id, source.enabled, source.model),
					),
			);
			if (!alive) return;
			let firstError: unknown = null;
			for (const result of settled) {
				if (result.status === "fulfilled") {
					mergeSettings(result.value);
				} else if (firstError === null) {
					firstError = result.reason;
				}
			}
			if (firstError !== null) {
				showToast(toasts, {
					variant: "error",
					title: t("settings.preferencesSaveFailed"),
					description: userErrorMessage(firstError),
				});
			} else {
				showToast(toasts, {
					variant: "success",
					title: t("settings.appliedToAllConnections"),
				});
			}
		} finally {
			if (alive) syncingAll.set(false);
		}
	};

	return (
		<View class="min-w-0 gap-3">
			<Text class="font-sans text-xs leading-5 text-muted-foreground">
				{t(`${props.labelPrefix}Description`)}
			</Text>
			{() =>
				catalogError() ? (
					<Text class="font-sans text-sm text-destructive">
						{catalogError()}
					</Text>
				) : null
			}
			<SettingsSection
				title={t(`${props.labelPrefix}Model`)}
				actions={() =>
					connections().length > 1 ? (
						<SettingsActionButton
							testID={`${props.testID}-apply-all`}
							disabled={
								syncingAll() ||
								anyRowBusy() ||
								!settings()[connections()[0]?.id ?? ""]
							}
							onPress={() => void applyToAll()}
						>
							<Text class="font-sans text-xs">
								{t("settings.applyToAllConnections")}
							</Text>
						</SettingsActionButton>
					) : null
				}
			>
				{() => {
					if (loadingCatalog()) {
						return (
							<SettingsSectionMessage padded="roomy">
								{t("common.loading")}
							</SettingsSectionMessage>
						);
					}
					return connections().flatMap((connection) => {
						const current = () => settings()[connection.id];
						const disabled = () =>
							!current() || busy()[connection.id] || syncingAll();
						const row = (
							<SettingsRow label={connectionLabel(connection)}>
								<ConnectionModelSelect
									testID={`${props.testID}-model-${connection.id}`}
									connection={connection}
									lists={lists}
									noneValue="follow"
									noneTitle={t(`${props.labelPrefix}FollowModel`)}
									value={
										current()?.model
											? modelKey(
													current()!.model!.provider,
													current()!.model!.id,
												)
											: "follow"
									}
									disabled={disabled()}
									onPick={(model) =>
										save(connection, {
											model: model
												? { provider: model.provider, id: model.id }
												: null,
										})
									}
								/>
								<Switch
									testID={`${props.testID}-${connection.id}`}
									checked={current()?.enabled ?? false}
									disabled={disabled()}
									onChange={({ checked }) =>
										save(connection, { enabled: checked })
									}
								/>
							</SettingsRow>
						);
						const error = errors()[connection.id];
						return error
							? [
									row,
									<SettingsSectionMessage tone="error" bordered>
										{error}
									</SettingsSectionMessage>,
								]
							: [row];
					});
				}}
			</SettingsSection>
		</View>
	);
}
