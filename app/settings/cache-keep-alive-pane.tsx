import { type Accessor, cleanup, keymap, signal, Text, View } from "nsh";

import { userErrorMessage } from "@shared/app-error";
import {
	type CacheKeepAliveSettings,
	defaultCacheKeepAliveSettings,
} from "@shared/cache-keep-alive";
import type { Connection } from "@shared/api/pi-runtime-types";
import type { AppState } from "../state/app-state";
import { t } from "../shell/i18n";
import { Command } from "../ui/command";
import { Icon } from "../ui/icon";
import { NumberInput } from "../ui/number-input";
import { Popover } from "../ui/popover";
import { Switch } from "../ui/switch";
import {
	ConnectionModelLists,
	RefreshModelsButton,
	connectionLabel,
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

/** Cache TTL and idle keep-alive bounds, the React inputs' minutes ranges. */
const TTL_MINUTES_RANGE = { min: 10 / 60, max: 1440 };
const DURATION_MINUTES_RANGE = { min: 1, max: 1440 };

const rowKey = (row: Pick<CacheKeepAliveSettings, "provider" | "modelId">) =>
	modelKey(row.provider, row.modelId);

/**
 * Cache keep-alive policies per connection: a table of only the enabled
 * rows (model · cache TTL minutes · keep-alive minutes · switch), plus the
 * add-model picker — a searchable list, as
 * `ConnectionCacheKeepAliveSettings`. Edits commit on blur or Enter and
 * Escape drops the draft; saves serialize per connection so a blur save and
 * a switch press cannot reorder each other.
 */
export function CacheKeepAlivePane(props: {
	state: Accessor<AppState>;
	client: SettingsClient;
}) {
	const lists = new ConnectionModelLists(props.client);
	const connections = signal<Connection[]>([]);
	const catalogError = signal<string | null>(null);
	const policies = signal<Record<string, CacheKeepAliveSettings[]>>({});
	const loaded = signal<Record<string, boolean>>({});
	const errors = signal<Record<string, string | undefined>>({});
	/** Pending saves per row, as React's `pending` count. */
	const pending = signal<Record<string, number>>({});
	/** Rows whose enable/disable save is in flight, as React's `disabling`. */
	const toggling = signal<Record<string, boolean>>({});
	const adding = signal<Record<string, boolean>>({});
	const pickerOpen = signal<Record<string, boolean>>({});
	/** Typed but uncommitted minutes per row. */
	const drafts = signal<
		Record<string, { ttl: number | null; duration: number | null } | undefined>
	>({});
	/** One save at a time per connection, as React's saveQueue. */
	const queues = new Map<string, Promise<boolean>>();
	let alive = true;
	cleanup(() => {
		alive = false;
	});

	// Escape drops the uncommitted minutes of every row, as React's
	// `handleKeyDown` did; the key still reaches the field and any popover.
	cleanup(
		keymap.bind(
			"escape",
			() => {
				const next = { ...drafts() };
				let changed = false;
				for (const key of Object.keys(next))
					if (next[key] !== undefined) {
						next[key] = undefined;
						changed = true;
					}
				if (changed) drafts.set(next);
			},
			{ when: "always", passThrough: true },
		),
	);

	const setError = (connectionId: string, error: string | null) =>
		errors.set({ ...errors(), [connectionId]: error ?? undefined });
	const rows = (connectionId: string) => policies()[connectionId] ?? [];
	const mergeRow = (saved: CacheKeepAliveSettings) => {
		const key = rowKey(saved);
		const merged = rows(saved.connectionId).map((row) =>
			rowKey(row) === key && row.updatedAtMs <= saved.updatedAtMs ? saved : row,
		);
		if (!merged.some((row) => rowKey(row) === key)) merged.push(saved);
		policies.set({ ...policies(), [saved.connectionId]: merged });
	};
	const mergeRows = (connectionId: string, next: CacheKeepAliveSettings[]) => {
		const merged = new Map(
			rows(connectionId).map((row) => [rowKey(row), row] as const),
		);
		for (const row of next)
			if ((merged.get(rowKey(row))?.updatedAtMs ?? -1) <= row.updatedAtMs)
				merged.set(rowKey(row), row);
		policies.set({ ...policies(), [connectionId]: [...merged.values()] });
	};
	const loadSettings = (connection: Connection) => {
		props.client
			.loadCacheKeepAliveSettings(connection.id)
			.then((next) => {
				if (!alive) return;
				mergeRows(connection.id, next);
				loaded.set({ ...loaded(), [connection.id]: true });
			})
			.catch((error: unknown) => {
				if (!alive) return;
				setError(connection.id, userErrorMessage(error));
				loaded.set({ ...loaded(), [connection.id]: true });
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
		if (event.type === "cache_keep_alive_settings_changed")
			mergeRow(event.settings);
	});

	/** Serialized per connection; resolves true when the save landed. */
	const save = (settings: CacheKeepAliveSettings): Promise<boolean> => {
		const connectionId = settings.connectionId;
		const key = `${connectionId}\n${rowKey(settings)}`;
		const run = (queues.get(connectionId) ?? Promise.resolve(true)).then(
			async () => {
				pending.set({ ...pending(), [key]: (pending()[key] ?? 0) + 1 });
				try {
					const saved = await props.client.saveCacheKeepAliveSettings(settings);
					if (!alive) return false;
					mergeRow(saved);
					setError(connectionId, null);
					return true;
				} catch (error) {
					if (alive) setError(connectionId, userErrorMessage(error));
					return false;
				} finally {
					if (alive)
						pending.set({ ...pending(), [key]: (pending()[key] ?? 1) - 1 });
				}
			},
		);
		queues.set(
			connectionId,
			run.catch(() => false),
		);
		return run;
	};

	/** The row's committed values, drafts applied, as React's `commit`. */
	const commit = (
		connection: Connection,
		row: CacheKeepAliveSettings,
		enabled = row.enabled,
	) => {
		const key = `${connection.id}\n${rowKey(row)}`;
		const draft = drafts()[key];
		const ttl = draft?.ttl ?? row.cacheTtlSeconds / 60;
		const duration = draft?.duration ?? row.idleKeepAliveSeconds / 60;
		const latest =
			rows(connection.id).find(
				(candidate) => rowKey(candidate) === rowKey(row),
			) ?? row;
		const filled = ttl !== null && duration !== null;
		// As React's validity gate: empty or out-of-range fields only block a
		// save that keeps the row enabled.
		if (!filled && enabled) {
			drafts.set({ ...drafts(), [key]: undefined });
			return;
		}
		const next = {
			...latest,
			enabled,
			...(filled
				? {
						cacheTtlSeconds: Math.round(ttl! * 60),
						idleKeepAliveSeconds: Math.round(duration! * 60),
					}
				: {}),
		};
		if (
			next.enabled === latest.enabled &&
			next.cacheTtlSeconds === latest.cacheTtlSeconds &&
			next.idleKeepAliveSeconds === latest.idleKeepAliveSeconds
		) {
			drafts.set({ ...drafts(), [key]: undefined });
			return;
		}
		void save(next).then((saved) => {
			if (saved) drafts.set({ ...drafts(), [key]: undefined });
		});
	};

	const toggle = (connection: Connection, row: CacheKeepAliveSettings) => {
		const key = `${connection.id}\n${rowKey(row)}`;
		if (toggling()[key]) return;
		toggling.set({ ...toggling(), [key]: true });
		commit(connection, { ...row, enabled: !row.enabled });
		// `commit` queues the save; clear the disabling flag once it settles.
		void (queues.get(connection.id) ?? Promise.resolve()).finally(() => {
			if (alive) toggling.set({ ...toggling(), [key]: false });
		});
	};

	const add = (connection: Connection, modelId: string) => {
		if (adding()[connection.id]) return;
		const list = lists.state(connection.id)();
		const model = list.models.find(
			(candidate) => modelKey(candidate.provider, candidate.id) === modelId,
		);
		if (!model) return;
		adding.set({ ...adding(), [connection.id]: true });
		const settings = {
			...(rows(connection.id).find(
				(row) => row.provider === model.provider && row.modelId === model.id,
			) ??
				defaultCacheKeepAliveSettings(connection.id, model.provider, model.id)),
			enabled: true,
		};
		void save(settings).then((saved) => {
			if (!alive) return;
			adding.set({ ...adding(), [connection.id]: false });
			if (saved) pickerOpen.set({ ...pickerOpen(), [connection.id]: false });
		});
	};

	return (
		<View class="min-w-0 gap-3">
			<Text class="font-sans text-xs leading-5 text-muted-foreground">
				{t("settings.cacheKeepAliveDescription")}
			</Text>
			{() =>
				catalogError() ? (
					<Text class="font-sans text-sm text-destructive">
						{catalogError()}
					</Text>
				) : null
			}
			{() => {
				const conns = connections();
				if (!conns.length && !catalogError()) return null;
				return conns.map((connection) => {
					const connectionId = connection.id;
					const list = () => lists.state(connectionId)();
					const enabledRows = () =>
						rows(connectionId).filter((row) => row.enabled);
					const configured = () =>
						new Set(enabledRows().map((row) => rowKey(row)));
					const available = () =>
						list().models.filter(
							(model) => !configured().has(modelKey(model.provider, model.id)),
						);
					const modelName = (row: CacheKeepAliveSettings) =>
						list().models.find(
							(model) =>
								model.provider === row.provider && model.id === row.modelId,
						)?.name || row.modelId;
					return (
						<SettingsSection
							title={connectionLabel(connection)}
							headerRight={
								<RefreshModelsButton
									loading={list().loading}
									onPress={() => lists.refresh(connectionId)}
								/>
							}
							actions={
								<Popover
									open={pickerOpen()[connectionId] ?? false}
									onOpenChange={({ open }) =>
										pickerOpen.set({
											...pickerOpen(),
											[connectionId]: open,
										})
									}
									align="end"
									popupClass="w-80 p-0 overflow-hidden"
									trigger={
										<SettingsActionButton
											testID={`settings-keep-alive-add-${connectionId}`}
											disabled={
												!loaded()[connectionId] || adding()[connectionId]
											}
										>
											<Icon name="Plus" size={14} />
											<Text class="font-sans">
												{t("settings.cacheKeepAliveAddModel")}
											</Text>
										</SettingsActionButton>
									}
								>
									<Command
										items={available().map((model) => ({
											id: modelKey(model.provider, model.id),
											label: `${model.name || model.id} · ${model.provider}`,
											keywords: [model.name, model.id, model.provider].filter(
												Boolean,
											),
											disabled: adding()[connectionId],
										}))}
										autoFocus
										placeholder={String(t("chat.searchModels"))}
										searchAccessibilityLabel={String(t("chat.searchModels"))}
										accessibilityLabel={String(
											t("settings.cacheKeepAliveModel"),
										)}
										empty={
											<Text class="font-sans text-muted-foreground">
												{t("chat.noModelMatches")}
											</Text>
										}
										onSelect={({ id }) => add(connection, id)}
										onCancel={() =>
											pickerOpen.set({
												...pickerOpen(),
												[connectionId]: false,
											})
										}
									/>
								</Popover>
							}
						>
							{() => {
								if (!loaded()[connectionId])
									return (
										<SettingsSectionMessage padded="default">
											{t("common.loading")}
										</SettingsSectionMessage>
									);
								const header = (
									<View class="flex-row items-center gap-2 border-b border-border/60 px-3 py-2">
										<View class="min-w-0 flex-1">
											<Text class="font-sans text-xs font-medium text-muted-foreground">
												{t("settings.cacheKeepAliveModel")}
											</Text>
										</View>
										<View class="w-28">
											<Text class="font-sans text-xs font-medium text-muted-foreground">
												{`${t("settings.cacheKeepAliveTtlLabel")} (${t(
													"settings.cacheKeepAliveMinutes",
												)})`}
											</Text>
										</View>
										<View class="w-32">
											<Text class="font-sans text-xs font-medium text-muted-foreground">
												{`${t("settings.cacheKeepAliveDurationLabel")} (${t(
													"settings.cacheKeepAliveMinutes",
												)})`}
											</Text>
										</View>
										<View class="w-20 items-center">
											<Text class="font-sans text-xs font-medium text-muted-foreground">
												{t("settings.cacheKeepAliveEnabledLabel")}
											</Text>
										</View>
									</View>
								);
								const body = enabledRows().map((row) => {
									const key = `${connectionId}\n${rowKey(row)}`;
									const draft = () => drafts()[key];
									const disabling = () => toggling()[key] ?? false;
									return (
										<SettingsRow label={modelName(row)} helper={row.provider}>
											<View class="flex-row items-center gap-2">
												<NumberInput
													testID={`settings-keep-alive-ttl-${connectionId}-${row.modelId}`}
													size="sm"
													class="w-28"
													inputClass="tabular-nums"
													min={TTL_MINUTES_RANGE.min}
													max={TTL_MINUTES_RANGE.max}
													step={1}
													disabled={disabling()}
													accessibilityLabel={t("settings.cacheKeepAliveTtl")}
													value={draft()?.ttl ?? row.cacheTtlSeconds / 60}
													onChange={({ value }) =>
														drafts.set({
															...drafts(),
															[key]: {
																ttl: value,
																duration:
																	draft()?.duration ??
																	row.idleKeepAliveSeconds / 60,
															},
														})
													}
													onSubmit={() => commit(connection, row)}
													onBlur={() => commit(connection, row)}
												/>
												<NumberInput
													testID={`settings-keep-alive-duration-${connectionId}-${row.modelId}`}
													size="sm"
													class="w-32"
													inputClass="tabular-nums"
													min={DURATION_MINUTES_RANGE.min}
													max={DURATION_MINUTES_RANGE.max}
													step={1}
													disabled={disabling()}
													accessibilityLabel={t(
														"settings.cacheKeepAliveDuration",
													)}
													value={
														draft()?.duration ?? row.idleKeepAliveSeconds / 60
													}
													onChange={({ value }) =>
														drafts.set({
															...drafts(),
															[key]: {
																ttl: draft()?.ttl ?? row.cacheTtlSeconds / 60,
																duration: value,
															},
														})
													}
													onSubmit={() => commit(connection, row)}
													onBlur={() => commit(connection, row)}
												/>
												<View class="w-20 items-center">
													<Switch
														testID={`settings-keep-alive-${connectionId}-${row.modelId}`}
														checked={row.enabled}
														disabled={disabling()}
														accessibilityLabel={t(
															"settings.cacheKeepAliveEnabled",
														)}
														onChange={() => toggle(connection, row)}
													/>
												</View>
											</View>
										</SettingsRow>
									);
								});
								const empty =
									enabledRows().length === 0 && !errors()[connectionId] ? (
										<SettingsSectionMessage padded="default">
											{t(
												available().length
													? "settings.cacheKeepAliveEmpty"
													: "settings.cacheKeepAliveNoModels",
											)}
										</SettingsSectionMessage>
									) : null;
								const error = errors()[connectionId] ? (
									<SettingsSectionMessage tone="error">
										{errors()[connectionId]}
									</SettingsSectionMessage>
								) : null;
								return [header, ...body, empty, error];
							}}
						</SettingsSection>
					);
				});
			}}
		</View>
	);
}
