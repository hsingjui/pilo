import { cleanup, signal, Text, View } from "nsh";

import type {
	Connection,
	PiloRuntimeEvent,
} from "@shared/api/pi-runtime-types";
import { userErrorMessage } from "@shared/app-error";
import type { NextPromptSettings } from "@shared/next-prompt-types";
import type { PromptEnhancementSettings } from "@shared/prompt-enhancement-types";
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
import { SettingsRow, SettingsSection, SettingsSectionMessage } from "./layout";
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
	const lists = new ConnectionModelLists(props.client);
	const connections = signal<Connection[]>([]);
	const catalogError = signal<string | null>(null);
	const settings = signal<Record<string, PromptSettings>>({});
	const busy = signal<Record<string, boolean>>({});
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
		});

	subscribeSettingsEvents(props.client, (event) => {
		const next = props.readEvent(event);
		if (next) mergeSettings(next);
	});

	const save = (
		connection: Connection,
		patch: { enabled?: boolean; model?: PromptSettings["model"] },
	) => {
		const connectionId = connection.id;
		if (busy()[connectionId]) return;
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
				if (alive) setError(connectionId, userErrorMessage(error));
			})
			.finally(() => {
				if (alive) busy.set({ ...busy(), [connectionId]: false });
			});
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
			<SettingsSection title={t(`${props.labelPrefix}Model`)}>
				{() =>
					connections().flatMap((connection) => {
						const current = () => settings()[connection.id];
						const disabled = () => !current() || busy()[connection.id];
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
					})
				}
			</SettingsSection>
		</View>
	);
}
