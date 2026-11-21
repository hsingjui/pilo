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
	const [updateWorker, setUpdateWorker] = useState<ServiceWorker | null>(null);
	const updateWorkerRef = useRef<ServiceWorker | null>(null);
	const applyingUpdateRef = useRef(false);
	// Dismissal follows the worker through activation, not subsequent builds.
	const [dismissedWorker, setDismissedWorker] = useState<ServiceWorker | null>(
		null,
	);
	const dismissUpdate = useCallback(
		() => setDismissedWorker(updateWorker),
		[updateWorker],
	);

	useEffect(() => {
		if (!supported) return;

		const serviceWorker = navigator.serviceWorker;
		const initialController = serviceWorker.controller;
		let disposed = false;
		let registration: ServiceWorkerRegistration | null = null;
		let installingWorker: ServiceWorker | null = null;

		const syncUpdateWorker = () => {
			if (disposed || !registration || !initialController) return;

			// Another tab can activate the update while this page still runs old code.
			const { waiting, active } = registration;
			const worker = waiting ?? (active !== initialController ? active : null);
			if (worker === updateWorkerRef.current) return;
			updateWorkerRef.current?.removeEventListener(
				"statechange",
				syncUpdateWorker,
			);
			updateWorkerRef.current = worker;
			worker?.addEventListener("statechange", syncUpdateWorker);
			setUpdateWorker(worker);
		};
		const handleInstallingStateChange = () => {
			if (installingWorker?.state === "installed") syncUpdateWorker();
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
			syncUpdateWorker();
			void registration?.update().catch(() => undefined);
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState === "visible") requestUpdate();
		};

		serviceWorker.addEventListener("controllerchange", syncUpdateWorker);
		window.addEventListener("online", requestUpdate);
		document.addEventListener("visibilitychange", handleVisibilityChange);

		const register = () => {
			void serviceWorker
				.register(SERVICE_WORKER_URL, {
					scope: SERVICE_WORKER_SCOPE,
					updateViaCache: "none",
				})
				.then((nextRegistration) => {
					if (disposed) return;
					registration = nextRegistration;
					registration.addEventListener("updatefound", handleUpdateFound);
					handleUpdateFound();
					syncUpdateWorker();
					requestUpdate();
				})
				.catch(() => undefined);
		};
		// Initial precaching must not compete with the page's outstanding assets.
		if (document.readyState === "complete") register();
		else window.addEventListener("load", register, { once: true });

		return () => {
			disposed = true;
			window.removeEventListener("load", register);
			registration?.removeEventListener("updatefound", handleUpdateFound);
			installingWorker?.removeEventListener(
				"statechange",
				handleInstallingStateChange,
			);
			updateWorkerRef.current?.removeEventListener(
				"statechange",
				syncUpdateWorker,
			);
			updateWorkerRef.current = null;
			serviceWorker.removeEventListener("controllerchange", syncUpdateWorker);
			window.removeEventListener("online", requestUpdate);
			document.removeEventListener("visibilitychange", handleVisibilityChange);
		};
	}, [supported]);

	const applyUpdate = useCallback(async () => {
		const worker = updateWorkerRef.current;
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

			if (worker.state === "installed") {
				// ServiceWorker.postMessage has no targetOrigin parameter.
				// oxlint-disable-next-line unicorn/require-post-message-target-origin
				worker.postMessage({ type: "SKIP_WAITING" });
			}
			if (await activated) window.location.reload();
		} finally {
			applyingUpdateRef.current = false;
		}
	}, []);

	return {
		supported,
		updateAvailable: updateWorker !== null && updateWorker !== dismissedWorker,
		applyUpdate,
		dismissUpdate,
	};
}
