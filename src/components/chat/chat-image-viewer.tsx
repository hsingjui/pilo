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
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Download, ImageOff, LoaderCircle, X } from "lucide-react";

import {
	chatImageCacheKey,
	getLocalChatImageUrl,
	loadChatHistoryImageUrl,
	type ChatHistoryImageScope,
} from "@/lib/chat-image-media";
import {
	formatChatImageSize,
	type ChatConversationImage,
} from "@/lib/chat-submission";
import { isImeComposingNativeKeyboardEvent } from "@/lib/ime";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui";

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
				message: "图片预览缓存已释放，重新打开会话后可从历史记录加载",
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
function useLazyImageVisible<T extends HTMLElement>(disabled: boolean) {
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
	const state = useChatImageLightboxState();
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
					className="fixed inset-0 z-[var(--z-dialog)] flex flex-col p-3 outline-none @min-[40rem]:p-6"
					onEscapeKeyDown={(event) => {
						if (isImeComposingNativeKeyboardEvent(event)) {
							event.preventDefault();
						}
					}}
				>
					<div className="flex items-center justify-between gap-3 py-1">
						<DialogPrimitive.Title className="min-w-0 truncate text-sm text-white/90">
							{state?.name ?? "图片"}
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
									download={state.name || "image"}
									className="inline-flex size-7 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/15 hover:text-white"
									aria-label="保存图片"
								>
									<Download className="size-4" />
								</a>
							) : null}
							<DialogPrimitive.Close
								className="inline-flex size-7 items-center justify-center rounded-md text-white/80 transition-colors hover:bg-white/15 hover:text-white"
								aria-label="关闭"
							>
								<X className="size-4" />
							</DialogPrimitive.Close>
						</div>
					</div>
					<div className="flex min-h-0 flex-1 items-center justify-center">
						{state ? (
							<DialogPrimitive.Description asChild>
								<img
									src={state.url}
									alt={state.name || "图片"}
									draggable={false}
									decoding="async"
									className="max-h-full max-w-full select-none rounded-md object-contain shadow-2xl"
								/>
							</DialogPrimitive.Description>
						) : null}
					</div>
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
}: {
	image: ChatConversationImage;
	alt?: string;
	className?: string;
}) {
	const lazy = image.source !== "local";
	const [observeRef, visible] = useLazyImageVisible<HTMLButtonElement>(lazy);
	const { source, retry } = useChatImageSource(image, visible);
	const label = image.name || "图片";

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
				aria-label={`查看图片 ${label}`}
				onClick={handleClick}
				className={cn(
					"group relative overflow-hidden rounded-lg border border-foreground/10 bg-muted/40 transition-colors hover:border-foreground/25",
					THUMBNAIL_SIZE_CLASS,
					className,
				)}
			>
				{source.status === "ready" ? (
					<img
						src={source.url}
						alt={alt ?? label}
						loading="lazy"
						decoding="async"
						draggable={false}
						className="size-full object-cover transition-transform duration-150 ease-out group-hover:scale-[1.03]"
					/>
				) : source.status === "error" ? (
					<span
						className="flex size-full flex-col items-center justify-center gap-1 px-1 text-[10px] leading-tight text-muted-foreground"
						role="alert"
					>
						<ImageOff className="size-4" />
						<span className="line-clamp-2">
							{retry ? "加载失败，点击重试" : source.message}
						</span>
					</span>
				) : (
					<span className="flex size-full items-center justify-center text-muted-foreground">
						{lazy ? (
							<span className="size-full animate-pulse bg-muted/70" />
						) : (
							<LoaderCircle className="size-4 animate-spin" />
						)}
					</span>
				)}
			</button>
		</Hint>
	);
});
