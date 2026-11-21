import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, ExternalLink, ShieldCheck } from "lucide-react";

import { sortRemoteAddresses } from "@shared/remote-addresses";
import { Button, Spinner } from "@/ui";
import {
	getRemotePairingInfo,
	pairRemote,
	remoteFetch,
	RemotePairingError,
	REMOTE_TOKEN_KEY,
	type RemotePairingInfo,
} from "./remote-client";
import {
	capturePairingBoot,
	clearPairingContext,
	pairingReturnUrl,
	pairingTargetAddress,
	pairingTargetUrl,
	preparePairingRequest,
	refreshPairingContext,
} from "./remote-pairing-model";
import { useRemotePwa } from "./use-remote-pwa";

type Failure =
	| "expired"
	| "used"
	| "storage"
	| "random"
	| "invalid"
	| "network";

function classifyFailure(error: unknown): Failure {
	if (error instanceof RemotePairingError) {
		if (error.status === 401) return "expired";
		if (error.status === 409) return "used";
		if (error.status === 400) return "invalid";
	}
	if (error instanceof Error) {
		if (error.message === "REMOTE_PAIRING_EXPIRED") return "expired";
		if (
			error.message === "REMOTE_PAIRING_STORAGE_UNAVAILABLE" ||
			error.name === "SecurityError" ||
			error.name === "QuotaExceededError"
		)
			return "storage";
		if (error.message === "REMOTE_PAIRING_RANDOM_UNAVAILABLE") return "random";
		if (error.message.startsWith("REMOTE_PAIRING_INVALID")) return "invalid";
	}
	return "network";
}

export function RemotePairingPage() {
	const { t } = useTranslation();
	const [boot, setBoot] = useState(capturePairingBoot);
	const [info, setInfo] = useState<RemotePairingInfo | null>(null);
	const [busy, setBusy] = useState(Boolean(boot.context));
	const [failure, setFailure] = useState<Failure | null>(() =>
		boot.error ? classifyFailure(new Error(boot.error)) : null,
	);
	const [authorized, setAuthorized] = useState(false);
	const [generation, setGeneration] = useState(0);
	const { updateAvailable, applyUpdate } = useRemotePwa();

	/* oxlint-disable react/set-state-in-effect -- Mirror the external pairing request and absolute credential expiry. */
	/* oxlint-disable react/exhaustive-effect-dependencies -- generation explicitly revalidates pairing on retry, online and foreground recovery. */
	useEffect(() => {
		if (!boot.context) return;
		let cancelled = false;
		const context = boot.context;
		setBusy(true);
		setFailure(null);
		void (async () => {
			const nextInfo = await getRemotePairingInfo(context.secret);
			if (cancelled) return;
			const entry =
				nextInfo.addresses.find(
					(address) => address.id === context.entryAddressId,
				) ??
				nextInfo.addresses.find(
					(address) => address.baseUrl === window.location.origin,
				);
			if (!entry || nextInfo.expiresAtMs <= Date.now())
				throw new RemotePairingError(401, "invalid or expired pairing link");
			const target = pairingTargetAddress(
				nextInfo.addresses,
				context.addressId,
				boot.target,
				window.location.origin,
			);
			const nextContext = refreshPairingContext({
				...context,
				addressId: target?.id ?? context.addressId,
				entryAddressId: entry.id,
				expiresAtMs: nextInfo.expiresAtMs,
			});
			setInfo(nextInfo);
			if (!target) return;
			const autoOpen = nextInfo.addresses.length === 1;
			const storedToken = window.localStorage.getItem(REMOTE_TOKEN_KEY);
			if (storedToken) {
				try {
					await remoteFetch<unknown>(storedToken, "/api/v1/bootstrap");
					if (!cancelled) {
						setAuthorized(true);
						if (autoOpen) window.location.replace("/");
					}
					return;
				} catch (error) {
					if (
						!(error instanceof Error) ||
						error.message !== "REMOTE_AUTH_EXPIRED"
					)
						throw error;
					if (cancelled) return;
					setAuthorized(false);
				}
			}
			if (cancelled) return;
			const request = preparePairingRequest(nextContext);
			const result = await pairRemote(
				request.secret,
				target.id,
				request.requestId,
			);
			if (cancelled) return;
			window.localStorage.setItem(REMOTE_TOKEN_KEY, result.token);
			setAuthorized(true);
			if (autoOpen) window.location.replace("/");
		})()
			.catch((error: unknown) => {
				if (cancelled) return;
				const reason = classifyFailure(error);
				setFailure(reason);
				if (reason === "expired") {
					clearPairingContext();
					setBoot((current) => ({ ...current, context: null }));
				}
			})
			.finally(() => {
				if (!cancelled) setBusy(false);
			});
		return () => {
			cancelled = true;
		};
	}, [boot, generation]);
	/* oxlint-enable react/exhaustive-effect-dependencies */
	/* oxlint-enable react/set-state-in-effect */

	const expiresAtMs = info?.expiresAtMs ?? boot.context?.expiresAtMs;
	useEffect(() => {
		if (!boot.context || expiresAtMs === undefined) return;
		const timer = window.setTimeout(
			() => {
				clearPairingContext();
				setBoot((current) => ({ ...current, context: null }));
				setFailure("expired");
				setBusy(false);
			},
			Math.max(0, expiresAtMs - Date.now()),
		);
		return () => window.clearTimeout(timer);
	}, [boot.context, expiresAtMs]);

	useEffect(() => {
		if (!boot.context) return;
		const refresh = () => {
			if (document.visibilityState === "visible")
				setGeneration((value) => value + 1);
		};
		window.addEventListener("online", refresh);
		document.addEventListener("visibilitychange", refresh);
		return () => {
			window.removeEventListener("online", refresh);
			document.removeEventListener("visibilitychange", refresh);
		};
	}, [boot.context]);

	const context = boot.context;
	const entry =
		info?.addresses.find((address) => address.id === context?.entryAddressId) ??
		info?.addresses.find(
			(address) => address.baseUrl === window.location.origin,
		);
	const errorMessage =
		failure === "expired"
			? t("settings.remotePairingExpiredDescription")
			: failure === "used"
				? t("settings.remotePairingAddressUsed")
				: failure === "storage"
					? t("settings.remotePairingStorageUnavailable")
					: failure === "random"
						? t("settings.remotePairingRandomUnavailable")
						: failure === "invalid"
							? t("settings.remotePairingInvalidLink")
							: failure === "network"
								? t("settings.remotePairingNetworkError")
								: null;

	if (
		!failure &&
		(busy || authorized) &&
		(!info || info.addresses.length === 1)
	) {
		return (
			<main className="flex min-h-dvh items-center justify-center bg-background px-4 pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground">
				<output className="flex items-center gap-2 text-sm text-muted-foreground">
					<Spinner className="size-4" />
					{t("settings.remoteConnecting")}
				</output>
			</main>
		);
	}

	return (
		<main className="flex min-h-dvh items-center justify-center bg-background px-4 pt-[max(24px,env(safe-area-inset-top))] pb-[max(24px,env(safe-area-inset-bottom))] text-foreground">
			<section className="w-full max-w-lg space-y-5 rounded-2xl border bg-card p-5 shadow-sm sm:p-6">
				<header className="space-y-2">
					<ShieldCheck className="size-7 text-muted-foreground" />
					<h1 className="text-lg font-semibold">
						{t("settings.remotePairingPageTitle")}
					</h1>
					<p className="text-sm leading-6 text-muted-foreground">
						{t("settings.remotePairingPageHint")}
					</p>
				</header>
				{busy ? (
					<output className="flex items-center gap-2 text-sm text-muted-foreground">
						<Spinner className="size-4" />
						{t("settings.remoteConnecting")}
					</output>
				) : null}
				{authorized ? (
					<div className="space-y-3">
						<output className="flex items-center gap-2 text-sm font-medium">
							<CheckCircle2 className="size-5" />
							{t("settings.remotePairingComplete")}
						</output>
						<p className="break-all text-sm text-muted-foreground">
							{window.location.origin}
						</p>
					</div>
				) : null}
				{errorMessage ? (
					<p role="alert" className="rounded-lg border p-3 text-sm leading-6">
						{errorMessage}
					</p>
				) : null}
				{!context && !failure ? (
					<p className="text-sm leading-6 text-muted-foreground">
						{t("settings.remotePairRequired")}
					</p>
				) : null}
				{!boot.target && info ? (
					<div className="space-y-3">
						{sortRemoteAddresses(info.addresses).map((address) => (
							<a
								key={address.id}
								className="flex min-h-14 items-center justify-between gap-3 rounded-xl border p-3 transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
								href={
									context && entry
										? pairingTargetUrl(address, context, entry.id)
										: address.baseUrl
								}
							>
								<div className="min-w-0 space-y-1">
									<p className="break-words text-sm font-medium">
										{address.baseUrl}
									</p>
									{address.issued ? (
										<p className="text-xs text-muted-foreground">
											{t("settings.remotePairingIssued")}
										</p>
									) : null}
								</div>
								<ExternalLink
									aria-hidden="true"
									className="size-4 shrink-0 text-muted-foreground"
								/>
							</a>
						))}
					</div>
				) : null}
				<div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
					{failure && context ? (
						<Button
							className="min-h-11"
							disabled={busy}
							onClick={() => setGeneration((value) => value + 1)}
						>
							{t("common.retry")}
						</Button>
					) : null}
					{boot.target && entry ? (
						<Button asChild variant="outline" className="min-h-11">
							<a href={pairingReturnUrl(entry)}>
								{t("settings.remotePairingContinue")}
							</a>
						</Button>
					) : null}
					<Button
						asChild
						variant={authorized ? "default" : "outline"}
						className="min-h-11"
					>
						<a href="/">{t("settings.remoteOpenPilo")}</a>
					</Button>
					{updateAvailable ? (
						<Button
							className="min-h-11"
							variant="outline"
							onClick={() => void applyUpdate()}
						>
							{t("settings.remoteUpdateAction")}
						</Button>
					) : null}
				</div>
			</section>
		</main>
	);
}
