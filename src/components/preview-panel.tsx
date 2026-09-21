import { useCallback, useEffect, useState } from "react";
import {
	ExternalLink,
	LoaderCircle,
	MonitorPlay,
	RefreshCw,
	X,
} from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";

import {
	closeProjectPreview,
	detectProjectPreviewPorts,
	openProjectPreview,
	type PreviewInfo,
} from "@/lib/preview";
import { userErrorMessage } from "@/lib/app-error";
import type { Project } from "@/lib/projects";
import { Button, EmptyState, Input } from "@/ui";

export function PreviewPanel({ project }: { project: Project }) {
	const [ports, setPorts] = useState<number[]>([]);
	const [portText, setPortText] = useState("");
	const [portError, setPortError] = useState<string | null>(null);
	const [preview, setPreview] = useState<PreviewInfo | null>(null);
	const [loadingPorts, setLoadingPorts] = useState(false);
	const [opening, setOpening] = useState(false);
	const [frameKey, setFrameKey] = useState(0);

	const detect = useCallback(async () => {
		setLoadingPorts(true);
		try {
			const next = await detectProjectPreviewPorts(project.id);
			setPorts(next);
			if (!portText && next.length === 1) setPortText(String(next[0]));
		} catch (error) {
			toast.error("无法检测预览端口", {
				description: userErrorMessage(error),
			});
		} finally {
			setLoadingPorts(false);
		}
	}, [portText, project.id]);

	useEffect(() => {
		const timer = window.setTimeout(() => void detect(), 0);
		return () => window.clearTimeout(timer);
	}, [detect]);

	useEffect(() => {
		return () => {
			if (preview) void closeProjectPreview(preview.id).catch(() => undefined);
		};
	}, [preview]);

	const open = useCallback(
		async (portOverride?: number) => {
			const port = portOverride ?? Number(portText);
			if (!Number.isInteger(port) || port < 1 || port > 65535) {
				setPortError("端口需为 1–65535 之间的整数。");
				return;
			}
			setPortError(null);
			setOpening(true);
			try {
				if (preview) await closeProjectPreview(preview.id);
				const next = await openProjectPreview(project.id, port);
				setPreview(next);
				setPortText(String(port));
				setFrameKey((value) => value + 1);
			} catch (error) {
				toast.error("无法打开 Preview", {
					description: userErrorMessage(error),
				});
			} finally {
				setOpening(false);
			}
		},
		[portText, preview, project.id],
	);

	const close = useCallback(async () => {
		if (!preview) return;
		const current = preview;
		setPreview(null);
		await closeProjectPreview(current.id).catch(() => undefined);
	}, [preview]);

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="grid shrink-0 gap-2 border-b border-sidebar-border p-2">
				<div className="flex items-center gap-1.5">
					<Input
						type="number"
						min={1}
						max={65535}
						value={portText}
						onChange={(event) => {
							setPortText(event.target.value);
							if (portError) setPortError(null);
						}}
						placeholder="端口，例如 3000"
						aria-invalid={portError ? true : undefined}
						aria-describedby={portError ? "preview-port-error" : undefined}
						className="h-7 min-w-0 flex-1 text-xs"
					/>
					<Button
						size="sm"
						className="h-7 gap-1.5 px-2 text-xs"
						disabled={opening}
						onClick={() => void open()}
					>
						{opening ? (
							<LoaderCircle className="size-3.5 animate-spin" />
						) : (
							<MonitorPlay className="size-3.5" />
						)}
						打开
					</Button>
					<Button
						variant="ghost"
						size="icon"
						className="size-7"
						disabled={loadingPorts}
						onClick={() => void detect()}
						aria-label="重新检测端口"
					>
						<RefreshCw
							className={`size-3.5 ${loadingPorts ? "animate-spin" : ""}`}
						/>
					</Button>
				</div>
				{portError ? (
					<p
						id="preview-port-error"
						className="text-xs text-destructive"
						role="alert"
					>
						{portError}
					</p>
				) : ports.length > 0 ? (
					<div className="flex flex-wrap gap-1">
						{ports.map((port) => (
							<button
								key={port}
								type="button"
								className="rounded-md border border-border px-1.5 py-0.5 font-mono text-2xs text-muted-foreground hover:bg-muted hover:text-foreground"
								onClick={() => void open(port)}
							>
								:{port}
							</button>
						))}
					</div>
				) : null}
			</div>

			{preview ? (
				<>
					<div className="flex h-8 shrink-0 items-center gap-1 border-b border-sidebar-border px-2">
						<span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground">
							{preview.url}
							{preview.tunneled ? " · SSH tunnel" : ""}
						</span>
						<Button
							variant="ghost"
							size="icon"
							className="size-6"
							aria-label="外部浏览器打开"
							onClick={() => void openUrl(preview.url)}
						>
							<ExternalLink className="size-3.5" />
						</Button>
						<Button
							variant="ghost"
							size="icon"
							className="size-6"
							aria-label="关闭 Preview"
							onClick={() => void close()}
						>
							<X className="size-3.5" />
						</Button>
					</div>
					<iframe
						key={frameKey}
						title={`Preview ${preview.remotePort}`}
						src={preview.url}
						sandbox="allow-downloads allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-scripts"
						className="min-h-0 flex-1 border-0 bg-white"
					/>
				</>
			) : (
				<EmptyState
					variant="compact"
					title="没有活动 Preview"
					description="选择检测到的端口或手动输入端口。SSH 会自动建立本地转发，WSL 使用 localhost 映射。"
				/>
			)}
		</div>
	);
}
