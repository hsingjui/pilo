import { useEffect, useRef, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { relaunch } from "@tauri-apps/plugin-process";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check, type Update } from "@tauri-apps/plugin-updater";
import {
	CheckCircle2,
	Code2,
	Download,
	ExternalLink,
	RefreshCw,
} from "lucide-react";

import appIconUrl from "../../../src-tauri/icons/128x128.png";
import { cn } from "@/lib/utils";
import { Button } from "@/ui";
import {
	SETTINGS_CONTAINER_CLASS,
	SETTINGS_TEXT_BUTTON_CLASS,
	SettingsRow,
	SettingsSection,
	SettingsStatus,
} from "./compact-layout";

const REPOSITORY_URL = "https://github.com/hsingjui/pilo";
const RELEASES_URL = `${REPOSITORY_URL}/releases`;

type UpdateStatus =
	| "idle"
	| "checking"
	| "latest"
	| "available"
	| "downloading"
	| "installing"
	| "error";

function formatUpdateError(error: unknown) {
	const message = error instanceof Error ? error.message : String(error);
	if (message.includes("public key") || message.includes("signature")) {
		return "更新签名配置不可用，请检查发布配置。";
	}
	if (message.includes("network") || message.includes("fetch")) {
		return "无法连接更新服务，请检查网络后重试。";
	}
	return message || "检查更新失败，请稍后重试。";
}

export function AboutSettings() {
	const [version, setVersion] = useState<string | null>(null);
	const [updateStatus, setUpdateStatus] = useState<UpdateStatus>("idle");
	const [availableVersion, setAvailableVersion] = useState<string | null>(null);
	const [updateError, setUpdateError] = useState<string | null>(null);
	const [downloadedBytes, setDownloadedBytes] = useState(0);
	const [downloadTotalBytes, setDownloadTotalBytes] = useState<number | null>(
		null,
	);
	const updateRef = useRef<Update | null>(null);

	useEffect(() => {
		let active = true;
		void getVersion()
			.then((nextVersion) => {
				if (active) setVersion(nextVersion);
			})
			.catch(() => {
				if (active) setVersion(null);
			});
		return () => {
			active = false;
			const update = updateRef.current;
			updateRef.current = null;
			if (update) void update.close();
		};
	}, []);

	const handleCheckForUpdates = async () => {
		if (updateStatus === "checking" || updateStatus === "downloading") return;

		setUpdateStatus("checking");
		setUpdateError(null);
		setAvailableVersion(null);
		setDownloadedBytes(0);
		setDownloadTotalBytes(null);

		const previousUpdate = updateRef.current;
		updateRef.current = null;
		if (previousUpdate) await previousUpdate.close().catch(() => undefined);

		try {
			const update = await check({ timeout: 15_000 });
			if (!update) {
				setUpdateStatus("latest");
				return;
			}

			updateRef.current = update;
			setAvailableVersion(update.version);
			setUpdateStatus("available");
		} catch (error) {
			setUpdateError(formatUpdateError(error));
			setUpdateStatus("error");
		}
	};

	const handleInstallUpdate = async () => {
		const update = updateRef.current;
		if (
			!update ||
			updateStatus === "downloading" ||
			updateStatus === "installing"
		) {
			return;
		}

		setUpdateStatus("downloading");
		setUpdateError(null);
		setDownloadedBytes(0);
		setDownloadTotalBytes(null);

		try {
			await update.download((event) => {
				if (event.event === "Started") {
					setDownloadTotalBytes(event.data.contentLength ?? null);
					return;
				}
				if (event.event === "Progress") {
					setDownloadedBytes((current) => current + event.data.chunkLength);
					return;
				}
				setUpdateStatus("installing");
			});

			setUpdateStatus("installing");
			await update.install();
			await relaunch();
		} catch (error) {
			setUpdateError(formatUpdateError(error));
			setUpdateStatus("error");
		}
	};

	const downloadProgress =
		downloadTotalBytes && downloadTotalBytes > 0
			? Math.min(100, Math.round((downloadedBytes / downloadTotalBytes) * 100))
			: null;

	return (
		<div className={SETTINGS_CONTAINER_CLASS}>
			<SettingsSection contentClassName="px-4 py-4 sm:px-5 sm:py-5">
				<div className="flex items-center gap-4">
					<div className="size-16 shrink-0 overflow-hidden rounded-2xl border border-border/60 bg-background shadow-sm">
						<img
							src={appIconUrl}
							alt="Pilo Logo"
							className="size-full object-cover"
						/>
					</div>
					<div className="min-w-0">
						<div className="flex flex-wrap items-center gap-2">
							<h3 className="text-lg font-semibold tracking-tight text-foreground">
								Pilo
							</h3>
							{version ? <SettingsStatus>v{version}</SettingsStatus> : null}
						</div>
						<p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
							轻量的 Pi 桌面客户端。
						</p>
					</div>
				</div>
			</SettingsSection>

			<SettingsSection title="应用">
				<SettingsRow label="版本">
					<span className="font-mono text-xs text-muted-foreground">
						{version ?? "—"}
					</span>
				</SettingsRow>
				<SettingsRow label="项目仓库">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={cn(
							SETTINGS_TEXT_BUTTON_CLASS,
							"text-muted-foreground hover:text-foreground",
						)}
						onClick={() => void openUrl(REPOSITORY_URL)}
					>
						<Code2 className="size-3.5" />
						GitHub
						<ExternalLink className="size-3.5 opacity-60" />
					</Button>
				</SettingsRow>
			</SettingsSection>

			<SettingsSection title="更新">
				<SettingsRow
					label="检查更新"
					helper={updateStatus === "error" ? updateError : undefined}
				>
					<div className="flex items-center gap-1.5">
						{updateStatus === "latest" ? (
							<SettingsStatus>
								<CheckCircle2 className="mr-1 size-3" />
								已是最新
							</SettingsStatus>
						) : null}
						{updateStatus === "available" && availableVersion ? (
							<SettingsStatus>v{availableVersion}</SettingsStatus>
						) : null}
						{updateStatus === "available" ? (
							<Button
								type="button"
								variant="default"
								size="sm"
								className={SETTINGS_TEXT_BUTTON_CLASS}
								onClick={() => void handleInstallUpdate()}
							>
								<Download className="size-3.5" />
								下载并安装
							</Button>
						) : (
							<Button
								type="button"
								variant="ghost"
								size="sm"
								className={cn(
									SETTINGS_TEXT_BUTTON_CLASS,
									"leading-none text-muted-foreground hover:text-foreground",
								)}
								disabled={
									updateStatus === "checking" ||
									updateStatus === "downloading" ||
									updateStatus === "installing"
								}
								onClick={() => void handleCheckForUpdates()}
							>
								<RefreshCw
									className={cn(
										"size-3.5",
										updateStatus === "checking" && "animate-spin",
									)}
								/>
								{updateStatus === "checking"
									? "检查中…"
									: updateStatus === "downloading"
										? downloadProgress === null
											? "下载中…"
											: `下载中 ${downloadProgress}%`
										: updateStatus === "installing"
											? "安装中…"
											: "检查更新"}
							</Button>
						)}
					</div>
				</SettingsRow>
				<SettingsRow label="发布记录">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className={cn(
							SETTINGS_TEXT_BUTTON_CLASS,
							"text-muted-foreground hover:text-foreground",
						)}
						onClick={() => void openUrl(RELEASES_URL)}
					>
						GitHub Releases
						<ExternalLink className="size-3.5 opacity-60" />
					</Button>
				</SettingsRow>
			</SettingsSection>
		</div>
	);
}
