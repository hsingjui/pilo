import { useEffect, useState } from "react";

export const CONFIGURATION_CHANGED_EVENT = "pilo:configuration-changed";

/** Refresh native settings panels when the Host commits configuration. */
export function useConfigurationRevision() {
	const [revision, setRevision] = useState(0);
	useEffect(() => {
		const changed = () => setRevision((value) => value + 1);
		window.addEventListener(CONFIGURATION_CHANGED_EVENT, changed);
		return () =>
			window.removeEventListener(CONFIGURATION_CHANGED_EVENT, changed);
	}, []);
	return revision;
}
