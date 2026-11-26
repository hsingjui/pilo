import { type Accessor, signal } from "nsh";

import type { ProjectPiModels } from "@shared/api/pi-models-types";
import { probeProjectPiModels } from "@shared/api/pi-models-probe";
import type { PiModel } from "@shared/api/pi-runtime-types";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@shared/project-model-scope";
import {
	getProjectScopeDefaultModel,
	getProjectScopeModels,
	isPiScopeCatalogResolved,
} from "@shared/pi-model-selection";
import { createNshModelProbe } from "../client/model-probe";
import type { NshPiloClient } from "../client/nsh-pilo-client";

export type ModelCatalogClient = Pick<
	NshPiloClient,
	| "startChat"
	| "stopChat"
	| "sendChatCommand"
	| "connectEvents"
	| "loadModels"
	| "saveModels"
	| "loadConnectionModels"
	| "loadModelScope"
	| "saveModelScope"
>;

export type ModelCatalogState = {
	projectId: string;
	/**
	 * The persisted catalog snapshot; `null` until one is read or refreshed.
	 * A project without one shows its connection's model list here instead.
	 */
	catalog: ProjectPiModels | null;
	/** `catalog` is the connection's model list, not a project snapshot. */
	provisional?: boolean;
	/** The project's saved Scope; `null` until its read finished. */
	scope: ProjectModelScope | null;
	/** Cache and scope reads finished; `false` while the catalog is unknown. */
	loaded: boolean;
	refreshing: boolean;
	savingScope: boolean;
	/** The last refresh's failure, cleared by the next one. */
	error: string | null;
};

/**
 * A project's model catalog and Scope as one signal: reads the persisted
 * snapshots on `open`, refreshes the catalog through a probe Pi on
 * `refresh`, and applies `project_model_scope_changed` events and saves.
 */
export class ModelCatalogStore {
	private readonly current = signal<ModelCatalogState | null>(null);
	readonly state: Accessor<ModelCatalogState | null> = this.current;

	private readonly client: ModelCatalogClient;
	private disconnect: (() => void) | undefined;
	/** Counts `open` calls so a late read cannot overwrite a newer project. */
	private opens = 0;
	private readonly refreshes = new Map<string, Promise<void>>();
	/** Each connection's model list, read once and shared across projects. */
	private readonly connectionModels = new Map<string, Promise<PiModel[]>>();

	constructor(client: ModelCatalogClient) {
		this.client = client;
	}

	/**
	 * Reads the cached catalog and Scope. When opening with a connection,
	 * probe missing project metadata and show its model list in the meantime.
	 */
	async open(projectId: string, connectionId?: string): Promise<void> {
		const open = ++this.opens;
		this.disconnect?.();
		this.disconnect = undefined;
		this.current.set({
			projectId,
			catalog: null,
			provisional: false,
			scope: null,
			loaded: false,
			refreshing: this.refreshes.has(projectId),
			savingScope: false,
			error: null,
		});
		const disconnect = await this.client.connectEvents({
			onMessage: (message) => {
				if (message.type !== "events") return;
				for (const event of message.events) {
					if (
						event.type === "project_model_scope_changed" &&
						event.scope.projectId === projectId &&
						this.current()?.projectId === projectId
					) {
						this.update({ scope: event.scope });
					}
				}
			},
			onStatus: () => {},
		});
		if (open !== this.opens) {
			disconnect();
			return;
		}
		this.disconnect = disconnect;
		const [catalog, scope] = await Promise.all([
			this.client.loadModels(projectId).catch(() => null),
			this.client.loadModelScope(projectId).catch(() => null),
		]);
		if (open !== this.opens) return;
		const state = this.current()!;
		const snapshot = state.catalog ?? catalog;
		const needsProbe =
			connectionId !== undefined &&
			(!snapshot || !isPiScopeCatalogResolved(snapshot.models));
		this.current.set({
			...state,
			catalog: snapshot,
			scope,
			loaded: true,
			refreshing: state.refreshing || needsProbe,
		});
		if (needsProbe) {
			void this.refresh();
			if (!snapshot)
				await this.showConnectionModels(open, projectId, connectionId);
		}
	}

	/** Fills a project without a cached catalog with its connection's models. */
	private async showConnectionModels(
		open: number,
		projectId: string,
		connectionId: string,
	): Promise<void> {
		let request = this.connectionModels.get(connectionId);
		if (!request) {
			const loading = this.client.loadConnectionModels(connectionId);
			request = loading;
			this.connectionModels.set(connectionId, loading);
			// A failed read is retried by the next open.
			loading.catch(() => {
				if (this.connectionModels.get(connectionId) === loading) {
					this.connectionModels.delete(connectionId);
				}
			});
		}
		let models: PiModel[];
		try {
			models = await request;
		} catch (error) {
			console.warn("Failed to load the connection's Pi models", error);
			return;
		}
		// A refresh that finished meanwhile wins over the connection's list.
		if (open !== this.opens || this.current()?.catalog) return;
		this.update({
			catalog: {
				projectId,
				models,
				commands: null,
				defaultModel: null,
				defaultThinkingLevel: null,
				refreshedAtMs: 0,
			},
			provisional: true,
		});
	}

	close(): void {
		this.opens += 1;
		this.disconnect?.();
		this.disconnect = undefined;
		this.current.set(null);
	}

	/** The catalog's models, empty while it is unloaded. */
	get models(): readonly PiModel[] {
		return this.current()?.catalog?.models ?? [];
	}

	/** The scope's effective model list, in cycle order. */
	get scopeModels(): readonly PiModel[] {
		const state = this.current();
		if (!state?.scope) return [];
		return getProjectScopeModels(this.models, state.scope);
	}

	/** The scope's new-chat default model, when it marks one. */
	get scopeDefaultModel(): PiModel | null {
		const state = this.current();
		return state ? getProjectScopeDefaultModel(this.models, state.scope) : null;
	}

	/** Whether the catalog resolved every model's Scope membership. */
	get scopeResolved(): boolean {
		const catalog = this.current()?.catalog;
		return catalog != null && isPiScopeCatalogResolved(catalog.models);
	}

	/** The catalog's Pi commands (without the probe's own), for the composer. */
	get commands() {
		return this.current()?.catalog?.commands ?? null;
	}

	/** Re-reads the catalog through a probe Pi and persists the snapshot. */
	async refresh(catalogTimeoutMs?: number): Promise<void> {
		const state = this.current();
		if (!state) return;
		const projectId = state.projectId;
		const inFlight = this.refreshes.get(projectId);
		if (inFlight) return inFlight;
		this.update({ refreshing: true, error: null });
		const run = probeProjectPiModels(
			projectId,
			{
				cached: state.provisional ? null : state.catalog,
				createClient: (project, sessionId) =>
					createNshModelProbe(this.client, project, sessionId),
				persist: (snapshot) => this.client.saveModels(snapshot),
			},
			{ catalogTimeoutMs },
		);
		const refreshing = run.then(
			(catalog) => {
				this.refreshes.delete(projectId);
				if (this.current()?.projectId !== projectId) return;
				this.update({ catalog, provisional: false, refreshing: false });
			},
			(error: unknown) => {
				this.refreshes.delete(projectId);
				if (this.current()?.projectId !== projectId) return;
				this.update({
					refreshing: false,
					error: error instanceof Error ? error.message : String(error),
				});
			},
		);
		this.refreshes.set(projectId, refreshing);
		return refreshing;
	}

	/** Saves the project Scope; the runtime event applies it here too. */
	async saveScope(models: ProjectScopedModel[] | null): Promise<void> {
		const state = this.current();
		if (!state) return;
		this.update({ savingScope: true });
		try {
			const scope = await this.client.saveModelScope(state.projectId, models);
			if (this.current()?.projectId === state.projectId) {
				this.update({ scope, savingScope: false });
			}
		} catch (error) {
			if (this.current()?.projectId === state.projectId) {
				this.update({ savingScope: false });
			}
			throw error;
		}
	}

	private update(patch: Partial<ModelCatalogState>): void {
		const state = this.current();
		if (state) this.current.set({ ...state, ...patch });
	}
}
