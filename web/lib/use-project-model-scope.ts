import { useCallback, useEffect, useRef, useState } from "react";

import type { PiloClient } from "@shared/api/pilo-client";
import {
	runtimeErrorMessage,
	type PiloRuntimeEvent,
} from "@/lib/api/pi-runtime";
import type {
	ProjectModelScope,
	ProjectScopedModel,
} from "@shared/project-model-scope";

export function useProjectModelScope(
	client: PiloClient | null,
	projectId: string,
	refreshKey = 0,
) {
	const [state, setState] = useState<{
		client: PiloClient | null;
		projectId: string;
		scope: ProjectModelScope | null;
		loading: boolean;
		error: string | null;
	}>({ client, projectId, scope: null, loading: true, error: null });
	const requestRef = useRef(0);
	const revisionRef = useRef({ client, projectId, revision: -1, epoch: 0 });
	const savingRef = useRef(false);
	const [saving, setSaving] = useState(false);

	const accept = useCallback(
		(scope: ProjectModelScope) => {
			const latest = revisionRef.current;
			if (
				scope.projectId !== projectId ||
				latest.client !== client ||
				latest.projectId !== projectId ||
				latest.revision > scope.updatedAtMs
			)
				return;
			revisionRef.current = { ...latest, revision: scope.updatedAtMs };
			setState((current) => {
				if (current.client !== client || current.projectId !== projectId)
					return current;
				if (current.scope && current.scope.updatedAtMs > scope.updatedAtMs)
					return current;
				return { ...current, scope, loading: false, error: null };
			});
		},
		[client, projectId],
	);

	const refresh = useCallback(async () => {
		if (!client || !projectId) return;
		const request = ++requestRef.current;
		const revision = revisionRef.current.revision;
		setState((current) =>
			current.client === client && current.projectId === projectId
				? { ...current, loading: true, error: null }
				: current,
		);
		try {
			const scope = await client.loadModelScope(projectId);
			if (request !== requestRef.current) return;
			accept(scope);
		} catch (error) {
			if (
				request !== requestRef.current ||
				revisionRef.current.revision !== revision
			)
				return;
			setState((current) =>
				current.client === client && current.projectId === projectId
					? { ...current, loading: false, error: runtimeErrorMessage(error) }
					: current,
			);
		} finally {
			if (request === requestRef.current) {
				setState((current) =>
					current.client === client && current.projectId === projectId
						? { ...current, loading: false }
						: current,
				);
			}
		}
	}, [accept, client, projectId]);

	/* oxlint-disable react/set-state-in-effect, react/exhaustive-effect-dependencies -- Project/transport changes reset server-owned preferences; recovery refreshes without touching editor drafts. refreshKey 是重取代的显式触发代，不是 effect 读取的值。 */
	useEffect(() => {
		void refreshKey;
		if (
			revisionRef.current.client !== client ||
			revisionRef.current.projectId !== projectId
		) {
			revisionRef.current = {
				client,
				projectId,
				revision: -1,
				epoch: revisionRef.current.epoch + 1,
			};
		}
		setState((current) =>
			current.client === client && current.projectId === projectId
				? current
				: { client, projectId, scope: null, loading: true, error: null },
		);
		void refresh();
		return () => {
			requestRef.current += 1;
		};
	}, [client, projectId, refresh, refreshKey]);
	/* oxlint-enable react/set-state-in-effect */

	/* oxlint-disable react/memo-dependencies -- accept/client/projectId 保持显式，使异步 save 闭包不会读到过期值。 */
	const save = useCallback(
		async (models: ProjectScopedModel[] | null) => {
			if (!client || !projectId || savingRef.current)
				throw new Error("Model scope is not ready to save");
			const epoch = revisionRef.current.epoch;
			savingRef.current = true;
			setSaving(true);
			try {
				const scope = await client.saveModelScope(projectId, models);
				if (revisionRef.current.epoch === epoch) accept(scope);
				return scope;
			} finally {
				savingRef.current = false;
				setSaving(false);
			}
		},
		[accept, client, projectId],
	);
	/* oxlint-enable react/memo-dependencies */

	const handleEvent = useCallback(
		(event: PiloRuntimeEvent) => {
			if (event.type === "project_model_scope_changed") accept(event.scope);
		},
		[accept],
	);
	const current = state.client === client && state.projectId === projectId;
	return {
		projectId,
		scope: current ? state.scope : null,
		loading: !current || state.loading,
		error: current ? state.error : null,
		saving,
		refresh,
		save,
		handleEvent,
	};
}
