import { useCallback, useEffect, useRef, useState } from "react";

const SERVICE_WORKER_URL = "/sw.js";
const SERVICE_WORKER_SCOPE = "/";

function canUseRemoteServiceWorker() {
	return (
		import.meta.env.PROD &&
		window.isSecureContext &&
		"serviceWorker" in navigator
	);
}

export function useRemotePwa() {
	const supported = canUseRemoteServiceWorker();
	const [waitingWorker, setWaitingWorker] = useState<ServiceWorker | null>(
		null,
	);
	const waitingWorkerRef = useRef<ServiceWorker | null>(null);
	const applyingUpdateRef = useRef(false);

	const captureWaitingWorker = useCallback((worker: ServiceWorker | null) => {
		waitingWorkerRef.current = worker;
		setWaitingWorker(worker);
	}, []);

	useEffect(() => {
		if (!supported) return;

		let disposed = false;
		let registration: ServiceWorkerRegistration | null = null;
		let installingWorker: ServiceWorker | null = null;

		const syncWaitingWorker = () => {
			if (disposed || !registration || !navigator.serviceWorker.controller) {
				return;
			}
			captureWaitingWorker(registration.waiting);
		};
		const handleInstallingStateChange = () => {
			if (installingWorker?.state === "installed") syncWaitingWorker();
		};
		const handleUpdateFound = () => {
			installingWorker?.removeEventListener(
				"statechange",
				handleInstallingStateChange,
			);
			installingWorker = registration?.installing ?? null;
			installingWorker?.addEventListener(
				"statechange",
				handleInstallingStateChange,
			);
		};
		const requestUpdate = () => {
			if (document.visibilityState !== "visible") return;
			void registration?.update().catch(() => undefined);
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible") requestUpdate();
		};

		window.addEventListener("online", requestUpdate);
		document.addEventListener("visibilitychange", handleVisibilityChange);

		void navigator.serviceWorker
			.register(SERVICE_WORKER_URL, {
				scope: SERVICE_WORKER_SCOPE,
				updateViaCache: "none",
			})
			.then((nextRegistration) => {
				if (disposed) return;
				registration = nextRegistration;
				registration.addEventListener("updatefound", handleUpdateFound);
				handleUpdateFound();
				syncWaitingWorker();
				requestUpdate();
			})
			.catch(() => undefined);

		return () => {
			disposed = true;
			registration?.removeEventListener("updatefound", handleUpdateFound);
			installingWorker?.removeEventListener(
				"statechange",
				handleInstallingStateChange,
			);
			window.removeEventListener("online", requestUpdate);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [captureWaitingWorker, supported]);

	const applyUpdate = useCallback(async () => {
		const worker = waitingWorkerRef.current;
		if (!worker || applyingUpdateRef.current) return;
		applyingUpdateRef.current = true;

		try {
			const activated = new Promise<boolean>((resolve) => {
				if (worker.state === "activated") {
					resolve(true);
					return;
				}
				if (worker.state === "redundant") {
					resolve(false);
					return;
				}
				const handleStateChange = () => {
					if (worker.state !== "activated" && worker.state !== "redundant") {
						return;
					}
					worker.removeEventListener("statechange", handleStateChange);
					resolve(worker.state === "activated");
				};
				worker.addEventListener("statechange", handleStateChange);
			});

			// ServiceWorker.postMessage has no targetOrigin parameter.
			// oxlint-disable-next-line unicorn/require-post-message-target-origin
			worker.postMessage({ type: "SKIP_WAITING" });
			if (await activated) window.location.reload();
		} finally {
			applyingUpdateRef.current = false;
		}
	}, []);

	return {
		supported,
		updateAvailable: waitingWorker !== null,
		applyUpdate,
	};
}
