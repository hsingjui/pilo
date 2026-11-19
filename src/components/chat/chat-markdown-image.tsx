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

function ImagePlaceholder({
	error,
	unavailable = false,
}: {
	error: boolean;
	unavailable?: boolean;
}) {
	const { t } = useTranslation();
	return error ? (
		<span className="inline-flex flex-col items-center gap-2" role="alert">
			<ImageOff className="size-5" />
			<span>
				{t(unavailable ? "chat.imageUnavailable" : "chat.loadImageFailed")}
			</span>
			{!unavailable ? (
				<span className="underline underline-offset-2">
					{t("common.retry")}
				</span>
			) : null}
		</span>
	) : (
		<Spinner className="size-5" />
	);
}

function ExternalMarkdownImage({
	src,
	alt,
	className,
	width,
	height,
	onLoad,
	onError,
	...props
}: ComponentPropsWithoutRef<"img"> & { src: string }) {
	const { t } = useTranslation();
	const [status, setStatus] = useState<"pending" | "ready" | "error">(
		"pending",
	);
	const [attempt, setAttempt] = useState(0);
	const label = alt || t("chat.image");
	return (
		<button
			type="button"
			aria-label={
				status === "error"
					? `${t("chat.loadImageFailed")}. ${t("common.retry")}`
					: t("chat.viewImage", { name: label })
			}
			disabled={status === "pending"}
			onClick={() => {
				if (status === "ready")
					openChatImageLightbox({ url: src, name: label });
				else {
					setStatus("pending");
					setAttempt((value) => value + 1);
				}
			}}
			className={cn(
				"my-2 inline-grid max-w-full overflow-hidden rounded-lg border border-foreground/10 bg-muted/40 align-middle focus-visible:outline-2 focus-visible:outline-ring",
				status !== "ready" && "min-h-28 min-w-44 text-xs text-muted-foreground",
			)}
			style={
				width && height
					? { width, aspectRatio: `${width} / ${height}` }
					: undefined
			}
		>
			{status !== "error" ? (
				<img
					{...props}
					key={attempt}
					src={src}
					alt={alt ?? ""}
					width={width}
					height={height}
					loading="lazy"
					decoding="async"
					onLoad={(event) => {
						setStatus("ready");
						onLoad?.(event);
					}}
					onError={(event) => {
						setStatus("error");
						onError?.(event);
					}}
					className={cn(
						"col-start-1 row-start-1 max-h-96 max-w-full object-contain",
						width && height && "h-full min-h-0 w-full",
						status === "pending" && "invisible",
						className,
					)}
				/>
			) : null}
			{status !== "ready" ? (
				<span className="col-start-1 row-start-1 flex items-center justify-center px-3 py-4">
					<ImagePlaceholder error={status === "error"} />
				</span>
			) : null}
		</button>
	);
}

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
					? `${t("chat.loadImageFailed")}. ${t("common.retry")}`
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
			) : (
				<ImagePlaceholder
					error={!scope || state.status === "error"}
					unavailable={!scope}
				/>
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
			<ExternalMarkdownImage
				{...props}
				key={source.url}
				src={source.url}
				alt={alt}
				className={className}
			/>
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
