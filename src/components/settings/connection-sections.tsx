import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
	Laptop,
	Monitor,
	Pencil,
	Plus,
	Server,
	Settings2,
	Trash2,
	Wifi,
} from "lucide-react";
import { toast } from "sonner";

import { listWslDistributions, type WslDistribution } from "@/lib/connections";
import { userErrorMessage } from "@/lib/app-error";
import { i18n } from "@/i18n";
import type { Connection } from "@/lib/pi-runtime";
import { connectionLabel } from "@/lib/projects";
import { IS_WINDOWS } from "@/components/title-bar";
import { cn } from "@/lib/utils";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DropdownMenu,
	Input,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
	Switch,
} from "@/ui";

import { AUTH_LABEL_KEYS, sshTargetLabel } from "./connection-form";
import {
	SETTINGS_CONTROL_CLASS,
	SETTINGS_ICON_BUTTON_CLASS,
	SETTINGS_NESTED_DIALOG_OVERLAY_CLASS,
	SettingsSection,
} from "./compact-layout";

function ConnectionIcon({ kind }: { kind: Connection["kind"] }) {
	if (kind.type === "local")
		return <Laptop className="size-3.5" aria-hidden="true" />;
	if (kind.type === "wsl")
		return <Monitor className="size-3.5" aria-hidden="true" />;
	return <Server className="size-3.5" aria-hidden="true" />;
}

type ConnectionRowProps = {
	connection: Connection;
	description: ReactNode;
	projectCount: number;
	shownInHome: boolean;
	busy: boolean;
	onToggleShown: (shown: boolean) => void;
	onTest: () => void;
	onConfigure: () => void;
	onEdit?: () => void;
	onRemove?: () => void;
};

export function ConnectionRow({
	connection,
	description,
	projectCount,
	shownInHome,
	busy,
	onToggleShown,
	onTest,
	onConfigure,
	onEdit,
	onRemove,
}: ConnectionRowProps) {
	const { t } = useTranslation();
	return (
		<div className="flex items-center gap-2.5 px-3 py-2.5 transition-colors hover:bg-hover/30">
			<div className="flex size-6 shrink-0 items-center justify-center text-foreground/70">
				<ConnectionIcon kind={connection.kind} />
			</div>
			<div className="min-w-0 flex-1">
				<div className="truncate text-sm font-medium">
					{connectionLabel(connection)}
				</div>
				<div className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground">
					{description}
					<span>
						{projectCount > 0
							? t("connection.projectCount", { count: projectCount })
							: t("connection.unlinkedProjects")}
					</span>
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-1">
				<span className="mr-1 flex items-center gap-2 text-2xs text-muted-foreground">
					{t("connection.shownInHome")}
					<Switch
						aria-label={t("connection.shownInHome")}
						checked={shownInHome}
						disabled={busy}
						onCheckedChange={onToggleShown}
					/>
				</span>
				<Button
					variant="ghost"
					size="icon"
					className={SETTINGS_ICON_BUTTON_CLASS}
					disabled={busy}
					onClick={onTest}
					aria-label={t("connection.test")}
					title={t("connection.test")}
				>
					<Wifi />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					className={SETTINGS_ICON_BUTTON_CLASS}
					disabled={busy}
					onClick={onConfigure}
					aria-label={t("connection.configure")}
					title={t("connection.configure")}
				>
					<Settings2 />
					<span className="sr-only">{t("connection.configure")}</span>
				</Button>
				{onEdit ? (
					<Button
						variant="ghost"
						size="icon"
						className={SETTINGS_ICON_BUTTON_CLASS}
						disabled={busy}
						onClick={onEdit}
						aria-label={t("connection.editSsh")}
						title={t("connection.editSsh")}
					>
						<Pencil />
						<span className="sr-only">{t("connection.editSsh")}</span>
					</Button>
				) : null}
				{onRemove ? (
					<Button
						variant="ghost"
						size="icon"
						className={cn(
							SETTINGS_ICON_BUTTON_CLASS,
							"hover:bg-destructive/10 hover:text-destructive",
						)}
						disabled={busy}
						onClick={onRemove}
						aria-label={t("connection.remove")}
						title={t("connection.remove")}
					>
						<Trash2 />
						<span className="sr-only">{t("connection.remove")}</span>
					</Button>
				) : null}
			</div>
		</div>
	);
}

export function ConnectionsSection({
	children,
	onAddSsh,
	onAddWsl,
}: {
	children: ReactNode;
	onAddSsh: () => void;
	onAddWsl: () => void;
}) {
	const { t } = useTranslation();
	return (
		<SettingsSection
			title={t("settings.connections")}
			actions={
				<AddConnectionMenu
					canAddWsl={IS_WINDOWS}
					onAddSsh={onAddSsh}
					onAddWsl={onAddWsl}
				/>
			}
		>
			{children}
		</SettingsSection>
	);
}

export type ConnectionSettingsDraft = {
	connection: Connection;
	name: string;
	piExecutable: string;
};

export function ConnectionSettingsDialog({
	draft,
	busy,
	probing,
	onChange,
	onClose,
	onProbe,
	onSave,
}: {
	draft: ConnectionSettingsDraft | null;
	busy: boolean;
	probing: boolean;
	onChange: (draft: ConnectionSettingsDraft) => void;
	onClose: () => void;
	onProbe: () => void;
	onSave: () => void;
}) {
	const usesLocalPi =
		draft?.connection.kind.type === "ssh" &&
		draft.connection.piRuntime === "local";
	const { t } = useTranslation();
	return (
		<Dialog open={draft !== null} onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				overlayClassName={SETTINGS_NESTED_DIALOG_OVERLAY_CLASS}
				className="max-w-md gap-4"
			>
				<DialogHeader>
					<DialogTitle>{t("connection.configureTitle")}</DialogTitle>
					<DialogDescription className="sr-only">
						{t("connection.configureTitle")}
					</DialogDescription>
				</DialogHeader>
				{draft ? (
					<div className="grid gap-3">
						<label htmlFor="connection-name" className="grid gap-1 text-xs">
							{t("connection.name")}
							<Input
								id="connection-name"
								className={SETTINGS_CONTROL_CLASS}
								value={draft.name}
								onChange={(event) =>
									onChange({ ...draft, name: event.target.value })
								}
							/>
						</label>
						{usesLocalPi ? (
							<div className="grid gap-1 text-xs">
								{t("connection.runtimeLocation")}
								<span className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-2xs text-muted-foreground">
									{t("connection.localPi")}
								</span>
							</div>
						) : (
							<label
								htmlFor="connection-pi-path"
								className="grid gap-1 text-xs"
							>
								{t("connection.piPath")}
								<div className="flex gap-2">
									<Input
										id="connection-pi-path"
										className={cn(SETTINGS_CONTROL_CLASS, "font-mono")}
										value={draft.piExecutable}
										onChange={(event) =>
											onChange({ ...draft, piExecutable: event.target.value })
										}
										placeholder={t("connection.autoDetect")}
									/>
									<Button
										variant="outline"
										size="sm"
										disabled={busy || probing}
										onClick={onProbe}
									>
										{probing
											? t("connection.detecting")
											: t("connection.detectPi")}
									</Button>
								</div>
							</label>
						)}
						<div className="mt-1 flex justify-end gap-2">
							<Button
								size="sm"
								variant="outline"
								disabled={busy}
								onClick={onClose}
							>
								{t("common.cancel")}
							</Button>
							<Button
								size="sm"
								disabled={busy || !draft.name.trim()}
								onClick={onSave}
							>
								{busy ? t("common.saving") : t("common.save")}
							</Button>
						</div>
					</div>
				) : null}
			</DialogContent>
		</Dialog>
	);
}

function AddConnectionMenu({
	canAddWsl,
	onAddSsh,
	onAddWsl,
	className,
}: {
	canAddWsl: boolean;
	onAddSsh: () => void;
	onAddWsl: () => void;
	className?: string;
}) {
	const { t } = useTranslation();
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<Button size="icon" variant="outline" className={cn(className)}>
					<Plus />
					<span className="sr-only">{t("connection.addConnection")}</span>
				</Button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end">
				{canAddWsl ? (
					<DropdownMenuItem onSelect={onAddWsl}>
						<Monitor />
						{t("connection.addWsl")}
					</DropdownMenuItem>
				) : null}
				<DropdownMenuItem onSelect={onAddSsh}>
					<Server />
					{t("connection.addSsh")}
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}

export function WslDistributionDialog({
	open,
	busy,
	addedDistros,
	onOpenChange,
	onAdd,
}: {
	open: boolean;
	busy: boolean;
	addedDistros: Set<string>;
	onOpenChange: (open: boolean) => void;
	onAdd: (distro: string) => void;
}) {
	const [distributions, setDistributions] = useState<WslDistribution[] | null>(
		null,
	);
	const { t } = useTranslation();

	useEffect(() => {
		if (!open || !IS_WINDOWS) return;
		let cancelled = false;
		void listWslDistributions()
			.then((items) => {
				if (!cancelled) setDistributions(items);
			})
			.catch((error) => {
				if (cancelled) return;
				setDistributions([]);
				toast.error(t("connection.loadWslFailed"), {
					description: userErrorMessage(error),
				});
			});
		return () => {
			cancelled = true;
		};
	}, [open, t]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				overlayClassName={SETTINGS_NESTED_DIALOG_OVERLAY_CLASS}
				className="max-w-md gap-4"
			>
				<DialogHeader>
					<DialogTitle>{t("connection.addWslTitle")}</DialogTitle>
					<DialogDescription className="sr-only">
						{t("connection.selectWsl")}
					</DialogDescription>
				</DialogHeader>
				<div className="max-h-72 divide-y divide-border/60 overflow-auto rounded-md border">
					{distributions === null ? (
						<div className="px-3 py-4 text-xs text-muted-foreground">
							{t("connection.loading")}
						</div>
					) : distributions.length === 0 ? (
						<div className="px-3 py-4 text-xs text-muted-foreground">
							{t("connection.noWsl")}
						</div>
					) : (
						distributions.map((distribution) => {
							const added = addedDistros.has(distribution.name);
							return (
								<div
									key={distribution.name}
									className="flex items-center gap-3 px-3 py-2"
								>
									<Monitor className="size-4 shrink-0 text-muted-foreground" />
									<span className="min-w-0 flex-1 truncate text-sm">
										{distribution.name}
									</span>
									<Button
										variant="outline"
										size="sm"
										disabled={busy || added}
										onClick={() => onAdd(distribution.name)}
									>
										{added ? t("common.added") : t("common.add")}
									</Button>
								</div>
							);
						})
					)}
				</div>
			</DialogContent>
		</Dialog>
	);
}

/** SSH 行副标题：目标 + 认证方式 + 代理。 */
export function sshConnectionDescription(connection: Connection): ReactNode {
	if (connection.kind.type !== "ssh") return null;
	const target = connection.kind.target;
	return (
		<>
			<span className="truncate font-mono">{sshTargetLabel(target)}</span>
			<span>{i18n.t(AUTH_LABEL_KEYS[target.authMethod])}</span>
			{target.type === "direct" && target.proxyJump ? (
				<span>{i18n.t("connection.via", { name: target.proxyJump })}</span>
			) : null}
		</>
	);
}
