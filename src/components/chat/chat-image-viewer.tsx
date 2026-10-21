import {
	createContext,
	memo,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
	type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Download, ExternalLink, ImageOff, X } from "lucide-react";

import { ChatImageViewport } from "@/components/chat/chat-image-viewport";
import { COMPOSER_ATTACHMENT_PREVIEW_CLASS_NAME } from "@/components/chat/composer-attachment";
import {
	chatImageCacheKey,
	getLocalChatImageUrl,
	loadChatHistoryImageUrl,
	type ChatHistoryImageScope,
} from "@/lib/chat/chat-image-media";
import {
	formatChatImageSize,
	type ChatConversationImage,
} from "@/lib/chat/chat-submission";
import { isImeComposingNativeKeyboardEvent } from "@/lib/ime";
import { cn } from "@/lib/utils";
import { Hint, Spinner } from "@/ui";

/**
 * History images resolve through the session scope; optimistic local messages
 * resolve from the bounded Blob URL cache and never keep base64 in message state.
 */
const ChatImageScopeContext = createContext<ChatHistoryImageScope | null>(null);

export function ChatImageScopeProvider({
	scope,
	children,
}: {
	scope: ChatHistoryImageScope | null;
	children: ReactNode;
}) {
	return (
		<ChatImageScopeContext.Provider value={scope}>
			{children}
		</ChatImageScopeContext.Provider>
	);
}

function useChatImageScope() {
	return useContext(ChatImageScopeContext);
}

type RemoteImageState =
	| { attempt: number; key: string; status: "ready"; url: string }
	| { attempt: number; key: string; status: "error"; message: string };

function useChatImageSource(image: ChatConversationImage, load: boolean) {
	const { t } = useTranslation();
	const scope = useChatImageScope();
	const local = image.source === "local";
	const key = local ? image.id : chatImageCacheKey(image, scope);
	const [attempt, setAttempt] = useState(0);
	const [remote, setRemote] = useState<RemoteImageState | null>(null);

	const localUrl = useMemo(
		() => (local ? getLocalChatImageUrl(image.id) : null),
		[image.id, local],
	);

	useEffect(() => {
		if (local || localUrl || !load || !scope) return;
		let cancelled = false;
		loadChatHistoryImageUrl(key, image, scope)
			.then((url) => {
				if (!cancelled) setRemote({ attempt, key, status: "ready", url });
			})
			.catch((error) => {
				if (!cancelled) {
					setRemote({
						attempt,
						key,
						status: "error",
						message: error instanceof Error ? error.message : String(error),
					});
				}
			});
		return () => {
			cancelled = true;
		};
	}, [attempt, image, key, load, local, localUrl, scope]);

	const retry = useCallback(() => setAttempt((value) => value + 1), []);
	if (localUrl) return { source: { status: "ready" as const, url: localUrl } };
	if (local) {
		return {
			source: {
				status: "error" as const,
				message: t("chat.imagePreviewReleased"),
			},
		};
	}
	// A mismatched attempt means a retry is in flight; show pending until it lands.
	if (remote && remote.attempt === attempt && remote.key === key) {
		return remote.status === "error"
			? { source: { status: "error" as const, message: remote.message }, retry }
			: { source: { status: "ready" as const, url: remote.url }, retry };
	}
	return { source: { status: "pending" as const }, retry };
}

const INTERSECTION_OBSERVER_SUPPORTED =
	typeof IntersectionObserver !== "undefined";

/** Observes the thumbnail and flips to visible slightly before it enters the viewport. */
export function useLazyImageVisible<T extends HTMLElement>(disabled: boolean) {
	const ref = useRef<T | null>(null);
	const [visible, setVisible] = useState(!INTERSECTION_OBSERVER_SUPPORTED);
	useEffect(() => {
		if (!INTERSECTION_OBSERVER_SUPPORTED || !disabled || visible) return;
		const node = ref.current;
		if (!node) return;
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) setVisible(true);
			},
			{ rootMargin: "240px" },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}, [disabled, visible]);
	return [ref, visible] as const;
}

type ChatImageLightboxPayload = {
	url: string;
	name: string;
	size?: number;
};

let lightboxState: ChatImageLightboxPayload | null = null;
const lightboxListeners = new Set<() => void>();

function emitLightboxChange() {
	for (const listener of lightboxListeners) listener();
}

export function openChatImageLightbox(payload: ChatImageLightboxPayload) {
	lightboxState = payload;
	emitLightboxChange();
}

function closeChatImageLightbox() {
	if (!lightboxState) return;
	lightboxState = null;
	emitLightboxChange();
}

function useChatImageLightboxState() {
	return useSyncExternalStore(
		(listener) => {
			lightboxListeners.add(listener);
			return () => lightboxListeners.delete(listener);
		},
		() => lightboxState,
	);
}

export const ChatImageLightbox = memo(function ChatImageLightbox() {
	const { t } = useTranslation();
	const state = useChatImageLightboxState();
	const downloadable = state?.url.startsWith("blob:") ?? false;
	return (
		<DialogPrimitive.Root
			open={state !== null}
			onOpenChange={(open) => {
				if (!open) closeChatImageLightbox();
			}}
		>
			<DialogPrimitive.Portal>
				<DialogPrimitive.Overlay className="fixed inset-0 z-[var(--z-dialog-overlay)] bg-black/75 backdrop-blur-[2px] duration-100 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
				<DialogPrimitive.Content
					className="fixed inset-0 z-[var(--z-dialog)] flex flex-col pb-[max(0.75rem,env(safe-area-inset-bottom))] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pt-[max(0.75rem,env(safe-area-inset-top))] outline-none @min-[40rem]:p-6"
					onEscapeKeyDown={(event) => {
						if (isImeComposingNativeKeyboardEvent(event)) {
							event.preventDefault();
						}
					}}
				>
					<div className="flex items-center justify-between gap-3 py-1">
						<DialogPrimitive.Title className="min-w-0 truncate text-sm text-white/90">
							{state?.name ?? t("chat.image")}
						</DialogPrimitive.Title>
						<div className="flex shrink-0 items-center gap-1 text-xs text-white/70">
							{state?.size ? (
								<span className="tabular-nums">
									{formatChatImageSize(state.size)}
								</span>
							) : null}
							{state ? (
								<a
									href={state.url}
									download={downloadable ? state.name || "image" : undefined}
									target={downloadable ? undefined : "_blank"}
									rel={downloadable ? undefined : "noopener noreferrer"}
									className="inline-flex size-9 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/15 hover:text-white any-pointer-coarse:size-11"
									aria-label={t(
										downloadable ? "chat.saveImage" : "chat.openOriginalImage",
									)}
								>
									{downloadable ? (
										<Download className="size-4" />
									) : (
										<ExternalLink className="size-4" />
									)}
								</a>
							) : null}
							<DialogPrimitive.Close
								className="inline-flex size-9 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/15 hover:text-white any-pointer-coarse:size-11"
								aria-label={t("chat.closeImage")}
							>
								<X className="size-4" />
							</DialogPrimitive.Close>
						</div>
					</div>
					{state ? (
						<ChatImageViewport
							key={state.url}
							url={state.url}
							name={state.name || t("chat.image")}
							onClose={closeChatImageLightbox}
						/>
					) : null}
				</DialogPrimitive.Content>
			</DialogPrimitive.Portal>
		</DialogPrimitive.Root>
	);
});

const THUMBNAIL_SIZE_CLASS = "size-20 shrink-0";

export const ChatImageThumbnail = memo(function ChatImageThumbnail({
	image,
	alt,
	className,
	compact = false,
}: {
	image: ChatConversationImage;
	alt?: string;
	className?: string;
	compact?: boolean;
}) {
	const lazy = image.source !== "local";
	const { t } = useTranslation();
	const [observeRef, visible] = useLazyImageVisible<HTMLButtonElement>(lazy);
	const { source, retry } = useChatImageSource(image, visible);
	const label = image.name || t("chat.image");

	const handleClick = useCallback(() => {
		if (source.status === "ready") {
			openChatImageLightbox({
				url: source.url,
				name: label,
				size: image.size,
			});
			return;
		}
		retry?.();
	}, [image.size, label, retry, source]);

	return (
		<Hint
			label={
				image.size ? `${label} · ${formatChatImageSize(image.size)}` : label
			}
		>
			<button
				ref={observeRef}
				type="button"
				aria-label={t("chat.viewImage", { name: label })}
				onClick={handleClick}
				className={cn(
					compact
						? COMPOSER_ATTACHMENT_PREVIEW_CLASS_NAME
						: cn(
								"group relative overflow-hidden rounded-lg border border-foreground/10 bg-muted/40 transition-colors hover:border-foreground/25",
								THUMBNAIL_SIZE_CLASS,
							),
					className,
				)}
			>
				<span
					className={
						compact ? "size-4 shrink-0 overflow-hidden rounded-sm" : "contents"
					}
				>
					{source.status === "ready" ? (
						<img
							src={source.url}
							alt={compact ? "" : (alt ?? label)}
							loading="lazy"
							decoding="async"
							draggable={false}
							className="size-full object-cover transition-transform duration-150 ease-out group-hover:scale-[1.03]"
						/>
					) : source.status === "error" ? (
						<span
							className={cn(
								"flex size-full flex-col items-center justify-center gap-1 text-2xs leading-tight text-muted-foreground",
								!compact && "px-1",
							)}
							role="alert"
						>
							<ImageOff className="size-4 shrink-0" />
							<span className={compact ? "sr-only" : "line-clamp-2"}>
								{retry ? t("chat.loadImageFailed") : source.message}
							</span>
						</span>
					) : (
						<span className="flex size-full items-center justify-center text-muted-foreground">
							{lazy ? (
								<span className="size-full animate-pulse bg-muted/70" />
							) : (
								<Spinner className="size-4" />
							)}
						</span>
					)}
				</span>
				{compact ? <span className="min-w-0 truncate">{label}</span> : null}
			</button>
		</Hint>
	);
});
