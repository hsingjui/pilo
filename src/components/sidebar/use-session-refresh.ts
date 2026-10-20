import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";

import { runtimeErrorMessage } from "@/lib/api/pi-runtime";
import type { SidebarSession } from "./types";

export function useSessionRefresh(
	session: SidebarSession,
	onRefresh?: (sessionId: string, projectId: string) => Promise<void>,
) {
	const { t } = useTranslation();
	const [refreshing, setRefreshing] = useState(false);
	const pendingRef = useRef(false);
	const disabled = Boolean(
		session.active || !session.sessionPath || refreshing,
	);
	const refresh = async () => {
		if (!onRefresh || disabled || pendingRef.current) return;
		pendingRef.current = true;
		setRefreshing(true);
		try {
			await onRefresh(session.id, session.projectId);
		} catch (error) {
			toast.error(t("chat.refreshSessionFailed"), {
				description: runtimeErrorMessage(error),
			});
		} finally {
			pendingRef.current = false;
			setRefreshing(false);
		}
	};
	return { refresh, disabled };
}
