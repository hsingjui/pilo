import {
	createContext,
	useContext,
	useEffect,
	useState,
	type ComponentPropsWithoutRef,
	type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { ImageOff } from "lucide-react";

import {
	openChatImageLightbox,
	useLazyImageVisible,
} from "@/components/chat/chat-image-viewer";
import {
	loadChatProjectImageUrl,
	type ChatProjectImageScope,
} from "@/lib/chat/chat-image-media";
import { resolveMarkdownImageSource } from "@/lib/chat/chat-markdown-images";
import { cn } from "@/lib/utils";
import { Spinner } from "@/ui";

const ProjectImageContext = createContext<ChatProjectImageScope | null>(null);

export function useChatProjectImageScope() {
	return useContext(ProjectImageContext);
}

export function ChatMarkdownImageScopeProvider({
	scope,
	children,
}: {
	scope: ChatProjectImageScope | null;
	children: ReactNode;
}) {
	return (
		<ProjectImageContext.Provider value={scope}>
			{children}
		</ProjectImageContext.Provider>
	);
}

type ImageState =
	| { status: "ready"; url: string }
	| { status: "error" }
	| { status: "pending" };

function ProjectMarkdownImage({
	path,
	mimeType,
	alt,
	className,
}: {
	path: string;
	mimeType: string;
	alt?: string;
	className?: string;
}) {
	const { t } = useTranslation();
	const scope = useContext(ProjectImageContext);
	const [ref, visible] = useLazyImageVisible<HTMLButtonElement>(true);
	const [attempt, setAttempt] = useState(0);
	const [state, setState] = useState<ImageState>({ status: "pending" });
	const label = alt || path.split("/").pop() || t("chat.image");

	/* oxlint-disable react/exhaustive-effect-dependencies -- attempt explicitly retriggers a read after a load/decode failure. */
	useEffect(() => {
		if (!scope || !visible) return;
		let cancelled = false;
		loadChatProjectImageUrl(path, mimeType, scope)
			.then((url) => {
				if (!cancelled) setState({ status: "ready", url });
			})
			.catch(() => {
				if (!cancelled) setState({ status: "error" });
			});
		return () => {
			cancelled = true;
		};
	}, [attempt, mimeType, path, scope, visible]);
	/* oxlint-enable react/exhaustive-effect-dependencies */

	const ready = scope && state.status === "ready";
	return (
		<button
			ref={ref}
			type="button"
			title={path}
			aria-label={
				state.status === "error"
					? t("chat.loadImageFailed")
					: t("chat.viewImage", { name: label })
			}
			disabled={!scope || state.status === "pending"}
			onClick={() => {
				if (ready)
					openChatImageLightbox({
						url: state.url,
						name: path.split("/").pop() || label,
					});
				else {
					setState({ status: "pending" });
					setAttempt((value) => value + 1);
				}
			}}
			className={cn(
				"my-2 inline-flex max-w-full overflow-hidden rounded-lg border border-foreground/10 bg-muted/40 align-middle transition-colors hover:border-foreground/25 focus-visible:outline-2 focus-visible:outline-ring",
				!ready &&
					"min-h-28 min-w-44 items-center justify-center px-3 py-4 text-xs text-muted-foreground",
				className,
			)}
		>
			{ready ? (
				<img
					src={state.url}
					alt={label}
					loading="lazy"
					decoding="async"
					onError={() => setState({ status: "error" })}
					className="max-h-96 max-w-full object-contain"
				/>
			) : !scope || state.status === "error" ? (
				<span className="inline-flex flex-col items-center gap-2" role="alert">
					<ImageOff className="size-5" />
					<span>
						{scope ? t("chat.loadImageFailed") : t("chat.imageUnavailable")}
					</span>
				</span>
			) : (
				<Spinner className="size-5" />
			)}
		</button>
	);
}

export function MarkdownImage({
	src,
	alt,
	className,
	node: _node,
	"data-pilo-image-src": projectSrc,
	...props
}: ComponentPropsWithoutRef<"img"> & {
	node?: unknown;
	"data-pilo-image-src"?: string;
}) {
	const { t } = useTranslation();
	const scope = useContext(ProjectImageContext);
	const source = resolveMarkdownImageSource(
		projectSrc ?? (typeof src === "string" ? src : undefined),
		scope?.baseDirectory,
	);
	if (source.type === "external")
		return (
			<button
				type="button"
				aria-label={t("chat.viewImage", { name: alt || t("chat.image") })}
				onClick={() =>
					openChatImageLightbox({ url: source.url, name: alt || "image" })
				}
				className="my-2 inline-flex max-w-full overflow-hidden rounded-lg align-middle focus-visible:outline-2 focus-visible:outline-ring"
			>
				<img
					{...props}
					src={source.url}
					alt={alt ?? ""}
					loading="lazy"
					decoding="async"
					className={cn("max-h-96 max-w-full object-contain", className)}
				/>
			</button>
		);
	if (source.type === "invalid")
		return (
			<span
				className="inline-flex items-center gap-2 text-xs text-muted-foreground"
				title={alt}
			>
				<ImageOff className="size-4" />
				{t("chat.imageUnavailable")}
			</span>
		);
	return (
		<ProjectMarkdownImage
			key={`${scope?.projectId}:${scope?.sessionKey}:${source.path}`}
			path={source.path}
			mimeType={source.mimeType}
			alt={alt}
			className={className}
		/>
	);
}
