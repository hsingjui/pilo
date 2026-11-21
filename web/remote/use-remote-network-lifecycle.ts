import { useEffect, useState } from "react";

export function useRemoteNetworkLifecycle() {
	const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine);
	const [recoveryGeneration, setRecoveryGeneration] = useState(0);
	const [foregroundGeneration, setForegroundGeneration] = useState(0);

	useEffect(() => {
		const requestRecovery = () =>
			setRecoveryGeneration((generation) => generation + 1);

		const handleOffline = () => {
			setBrowserOnline(false);
		};
		const handleOnline = () => {
			setBrowserOnline(true);
			requestRecovery();
		};
		// Foreground recovery probes the existing socket in connectRemoteEvents.
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible") {
				setBrowserOnline(navigator.onLine);
				if (navigator.onLine) setForegroundGeneration((value) => value + 1);
			}
		};

		window.addEventListener("offline", handleOffline);
		window.addEventListener("online", handleOnline);
		document.addEventListener("visibilitychange", handleVisibilityChange);
		return () => {
			window.removeEventListener("offline", handleOffline);
			window.removeEventListener("online", handleOnline);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, []);

	return { browserOnline, recoveryGeneration, foregroundGeneration };
}
