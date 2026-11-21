import { useEffect, useState } from "react";

const HISTORY_INDEX_WARNING_DELAY_MS = 2_000;

export function useHistoryIndexWarning(scopeKey: string | null) {
	const [warning, setWarning] = useState({ scopeKey, visible: false });
	if (warning.scopeKey !== scopeKey) {
		setWarning({ scopeKey, visible: false });
	}

	useEffect(() => {
		if (scopeKey === null) return;
		// A fresh history read can beat the asynchronous sidebar index update.
		const timer = window.setTimeout(() => {
			setWarning((current) =>
				current.scopeKey === scopeKey ? { scopeKey, visible: true } : current,
			);
		}, HISTORY_INDEX_WARNING_DELAY_MS);
		return () => window.clearTimeout(timer);
	}, [scopeKey]);

	return scopeKey !== null && warning.scopeKey === scopeKey && warning.visible;
}
