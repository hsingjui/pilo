import { useEffect, useRef, useState } from "react";

const FOREGROUND_RESUME_MIN_HIDDEN_MS = 1_500;

export function useRemoteNetworkLifecycle() {
	const [browserOnline, setBrowserOnline] = useState(() => navigator.onLine);
	const [recoveryGeneration, setRecoveryGeneration] = useState(0);
	const hiddenAtRef = useRef<number | null>(null);

	useEffect(() => {
		if (document.visibilityState === "hidden") {
			hiddenAtRef.current = Date.now();
		}
		const requestRecovery = () =>
			setRecoveryGeneration((generation) => generation + 1);

		const handleOffline = () => {
			setBrowserOnline(false);
		};
		const handleOnline = () => {
			setBrowserOnline(true);
			requestRecovery();
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === "hidden") {
				hiddenAtRef.current = Date.now();
				return;
			}

			const hiddenAt = hiddenAtRef.current;
			hiddenAtRef.current = null;
			const online = navigator.onLine;
			setBrowserOnline(online);
			if (
				online &&
				hiddenAt !== null &&
				Date.now() - hiddenAt >= FOREGROUND_RESUME_MIN_HIDDEN_MS
			) {
				requestRecovery();
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

	return { browserOnline, recoveryGeneration };
}
