import { userErrorMessage } from "@shared/app-error";
import type { AppStore } from "../state/app-store";
import { type AppToasts, showToast } from "./app-toasts";
import { t } from "./i18n";

const pending = new WeakMap<AppStore, Set<string>>();

export async function setSessionArchivedWithToast(
	store: AppStore,
	toasts: AppToasts | null,
	projectId: string,
	sessionPath: string,
	archived: boolean,
): Promise<void> {
	let active = pending.get(store);
	if (!active) {
		active = new Set();
		pending.set(store, active);
	}
	const key = JSON.stringify([projectId, sessionPath]);
	if (active.has(key)) return;
	active.add(key);
	try {
		if (!archived) {
			await store.unarchiveSession(projectId, sessionPath);
			return;
		}
		await store.archiveSession(projectId, sessionPath);
		showToast(toasts, {
			variant: "success",
			title: t("app.sessionArchived"),
			action: {
				label: t("sidebar.undoArchive"),
				onPress: () =>
					void setSessionArchivedWithToast(
						store,
						toasts,
						projectId,
						sessionPath,
						false,
					),
			},
		});
	} catch (error: unknown) {
		if (error instanceof Error && error.message === "REMOTE_AUTH_EXPIRED")
			return;
		showToast(toasts, {
			variant: "error",
			title: archived
				? t("app.archiveSessionFailed")
				: t("app.unarchiveSessionFailed"),
			description: userErrorMessage(error),
		});
	} finally {
		active.delete(key);
	}
}
