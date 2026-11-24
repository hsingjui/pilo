import { userErrorMessage } from "@shared/app-error";

import type { AppStore } from "../state/app-store";
import { type AppToasts, showToast } from "./app-toasts";
import { t } from "./i18n";

const deletingByStore = new WeakMap<object, Set<string>>();

function storeDeletingSet(store: object): Set<string> {
	let set = deletingByStore.get(store);
	if (!set) {
		set = new Set();
		deletingByStore.set(store, set);
	}
	return set;
}

/**
 * Deletes a saved session through `store` and surfaces the outcome as an app
 * toast: moved to trash vs deleted on success, or an error toast on failure
 * (suppressing expired remote auth, which redirects to sign-in).
 */
export async function deleteSessionWithToast(
	store: Pick<AppStore, "deleteSession">,
	toasts: AppToasts | null,
	projectId: string,
	sessionPath: string,
): Promise<void> {
	const deleting = storeDeletingSet(store);
	const key = `${projectId}\0${sessionPath}`;
	if (deleting.has(key)) return;
	deleting.add(key);
	try {
		const result = await store.deleteSession(projectId, sessionPath);
		showToast(toasts, {
			variant: "success",
			title:
				result.method === "trash"
					? t("app.sessionTrashed")
					: t("app.sessionDeleted"),
		});
	} catch (error: unknown) {
		if (error instanceof Error && error.message === "REMOTE_AUTH_EXPIRED") {
			return;
		}
		console.error("Deleting the session failed", error);
		showToast(toasts, {
			variant: "error",
			title: t("app.deleteSessionFailed"),
			description: userErrorMessage(error),
		});
	} finally {
		deleting.delete(key);
	}
}
