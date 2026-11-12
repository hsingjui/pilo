import { useEffect, useState } from "react";
import { Monitor } from "lucide-react";
import { useTranslation } from "react-i18next";

import { usePanZoomViewport } from "@/lib/use-pan-zoom-viewport";
import { cn } from "@/lib/utils";
import {
	Button,
	Dialog,
	DialogClose,
	DialogTitle,
	DialogTrigger,
	Spinner,
} from "@/ui";
import { DialogContentWithoutClose } from "@/ui/dialog";
import {
	connectRemoteScreen,
	decodeRemoteScreenDisplays,
	type RemoteScreenDisplay,
} from "./remote-client";

// Application close codes 4001–4008 from the Host screen socket.
const screenErrors = [
	"settings.remoteScreenDisabled",
	"settings.remoteScreenUnsupported",
	"settings.remoteScreenLocked",
	"settings.remoteScreenDisplayGone",
	"settings.remoteScreenFailed",
	"settings.remoteScreenBusy",
	"settings.remoteAuthorizationExpired",
	"settings.remoteScreenStalled",
] as const;

type ScreenFrame = { url: string; acknowledge: () => void };

export function RemoteScreen({ token }: { token: string }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const title = t("settings.remoteScreenView");
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button
					variant="ghost"
					size="icon"
					className="size-11 md:size-7"
					aria-label={title}
				>
					<Monitor className="size-4" />
				</Button>
			</DialogTrigger>
			<DialogContentWithoutClose
				aria-describedby={undefined}
				overlayClassName="bg-transparent"
				// Let the modal overlay receive taps in the gaps around the screen.
				style={{ pointerEvents: "none" }}
				className="top-0 left-0 flex h-[var(--remote-viewport-height,100dvh)] max-h-none w-full max-w-none translate-x-0 translate-y-0 flex-col items-center gap-2 rounded-none border-0 bg-transparent shadow-none outline-none [--screen-gutter:0.5rem] pt-[max(var(--screen-gutter),env(safe-area-inset-top))] pr-[max(var(--screen-gutter),env(safe-area-inset-right))] pb-[max(var(--screen-gutter),env(safe-area-inset-bottom))] pl-[max(var(--screen-gutter),env(safe-area-inset-left))] md:[--screen-gutter:1.5rem] any-pointer-coarse:pb-[max(2.75rem,env(safe-area-inset-bottom))]"
			>
				<DialogTitle className="sr-only">{title}</DialogTitle>
				{open ? <ScreenPreview token={token} /> : null}
				<DialogClose className="sr-only" tabIndex={-1}>
					{t("common.close")}
				</DialogClose>
			</DialogContentWithoutClose>
		</Dialog>
	);
}

function ScreenPreview({ token }: { token: string }) {
	const { t } = useTranslation();
	const [request, setRequest] = useState({ displayId: "" });
	const [selectedId, setSelectedId] = useState("");
	const [displays, setDisplays] = useState<RemoteScreenDisplay[]>([]);
	const [frame, setFrame] = useState<ScreenFrame | null>(null);
	const [error, setError] = useState<number | null>(null);

	useEffect(() => {
		let displayId = request.displayId;
		let displayGone = false;
		let socket: WebSocket | undefined;
		let displayedUrl: string | undefined;
		let pendingUrl: string | undefined;
		let timer: number | undefined;
		const stop = () => {
			const current = socket;
			socket = undefined;
			window.clearTimeout(timer);
			if (displayedUrl) URL.revokeObjectURL(displayedUrl);
			if (pendingUrl) URL.revokeObjectURL(pendingUrl);
			displayedUrl = undefined;
			pendingUrl = undefined;
			current?.close();
		};
		const connect = () => {
			if (socket || document.hidden) return;
			const current = connectRemoteScreen(token, displayId);
			socket = current;
			const fail = (code: number) => {
				if (socket !== current) return;
				displayGone = code === 4004;
				stop();
				setFrame(null);
				setError(code);
			};
			timer = window.setTimeout(() => fail(4008), 20_000);
			current.addEventListener("close", (event) => fail(event.code), {
				once: true,
			});
			current.addEventListener("message", (event: MessageEvent<unknown>) => {
				if (socket !== current) return;
				if (typeof event.data === "string") {
					const metadata = decodeRemoteScreenDisplays(event.data);
					if (!metadata) {
						fail(4005);
						return;
					}
					displayId = metadata.selectedId;
					setDisplays(metadata.displays);
					setSelectedId(displayId);
				} else if (event.data instanceof Blob && !pendingUrl) {
					window.clearTimeout(timer);
					const nextUrl = URL.createObjectURL(
						event.data.slice(0, event.data.size, "image/jpeg"),
					);
					pendingUrl = nextUrl;
					// Keep the previous frame visible while the browser decodes the next JPEG.
					const image = new Image();
					image.src = nextUrl;
					void image.decode().then(
						() => {
							if (socket !== current || pendingUrl !== nextUrl) return;
							setFrame({
								url: nextUrl,
								acknowledge: () => {
									if (socket !== current || pendingUrl !== nextUrl) return;
									if (displayedUrl) URL.revokeObjectURL(displayedUrl);
									displayedUrl = nextUrl;
									pendingUrl = undefined;
									if (current.readyState === WebSocket.OPEN)
										current.send("ack");
								},
							});
						},
						() => fail(4005),
					);
				}
			});
		};
		const onVisibility = () => {
			if (document.hidden) {
				stop();
				setFrame(null);
			} else if (!displayGone) {
				setError(null);
				connect();
			}
		};
		connect();
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			document.removeEventListener("visibilitychange", onVisibility);
			stop();
		};
	}, [request, token]);

	const view = (displayId: string) => {
		setFrame(null);
		setError(null);
		setSelectedId(displayId);
		setRequest({ displayId });
	};

	return (
		<>
			{frame ? (
				<ScreenViewport key={selectedId} frame={frame} />
			) : (
				<div className="pointer-events-auto my-auto flex max-w-full flex-col items-center gap-3 rounded-(--pilo-ui-floating-radius) border border-border bg-popover p-4 text-center text-sm text-popover-foreground shadow-(--pilo-shadow-floating)">
					{error === null ? <Spinner className="size-4" /> : null}
					<output>
						{t(
							error === null
								? "settings.remoteScreenStarting"
								: (screenErrors[error - 4001] ??
										"settings.remoteScreenDisconnected"),
						)}
					</output>
					{error !== null && error !== 4002 && error !== 4007 ? (
						<Button
							variant="outline"
							className="h-11"
							onClick={() => view(error === 4004 ? "" : selectedId)}
						>
							{t(
								error === 4004
									? "settings.remoteScreenBackToPrimary"
									: "common.retry",
							)}
						</Button>
					) : null}
				</div>
			)}
			{displays.length > 1 ? (
				<select
					aria-label={t("settings.remoteScreenSelectDisplay")}
					className="pointer-events-auto h-8 max-w-full shrink-0 rounded-(--pilo-ui-floating-radius) border border-border bg-popover px-3 text-sm text-popover-foreground shadow-(--pilo-shadow-floating) focus-visible:outline-2 focus-visible:outline-ring any-pointer-coarse:h-11"
					value={selectedId}
					onChange={(event) => view(event.target.value)}
				>
					{displays.map((display, index) => (
						<option key={display.id} value={display.id}>
							{t(
								display.primary
									? "settings.remoteScreenPrimary"
									: "settings.remoteScreenDisplay",
								{ number: index + 1 },
							)}
						</option>
					))}
				</select>
			) : null}
		</>
	);
}

function ScreenViewport({ frame }: { frame: ScreenFrame }) {
	const { t } = useTranslation();
	const { viewportProps, imageProps, scale } = usePanZoomViewport({
		allowNativeZoom: true,
	});
	/* oxlint-disable jsx-a11y/no-noninteractive-tabindex -- Focus enables keyboard zoom and pan. */
	return (
		<section
			{...viewportProps}
			aria-label={t("settings.remoteScreenView")}
			tabIndex={0}
			className="flex min-h-0 w-full flex-1 touch-none select-none items-center justify-center overflow-hidden p-2 focus-visible:outline-2 focus-visible:outline-ring [-webkit-touch-callout:none] md:p-3"
		>
			<img
				{...imageProps}
				src={frame.url}
				alt=""
				onLoad={frame.acknowledge}
				draggable={false}
				decoding="sync"
				className={cn(
					"pointer-events-auto max-h-full max-w-full shrink-0 border-4 border-muted bg-muted object-contain shadow-(--pilo-shadow-floating)",
					scale > 1 ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
				)}
			/>
		</section>
	);
	/* oxlint-enable jsx-a11y/no-noninteractive-tabindex */
}
