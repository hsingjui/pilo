import {
	computed,
	effect,
	Scroll,
	type Signal,
	signal,
	Text,
	token,
	untracked,
	View,
} from "nsh";

import type { FsEntry } from "@shared/api/files-types";
import type { Connection } from "@shared/api/pi-runtime-types";
import { isDefaultWorkspace, type Project } from "@shared/api/projects-types";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogDescription } from "../ui/dialog-description";
import { DialogFooter } from "../ui/dialog-footer";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { scrollbarLook } from "../ui/scrollbar";
import { Select } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { connectionLabel } from "./connection-label";
import { t } from "./i18n";

/** The client calls the dialog needs beyond adding the project. */
export type AddProjectApi = Pick<
	NshPiloClient,
	"listConnections" | "readConnectionDir" | "pickLocalProjectDirectory"
>;

function absoluteRemotePath(path: string) {
	const trimmed = path.trim();
	if (!trimmed || trimmed === "/") return "/";
	return `/${trimmed.replace(/^\/+|\/+$/g, "")}`;
}

function parentRemotePath(path: string) {
	const normalized = absoluteRemotePath(path);
	if (normalized === "/") return "/";
	const parts = normalized.split("/").filter(Boolean);
	parts.pop();
	return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Adds a project on a connection: a typed path, the host's folder picker for
 * Local, or an inline directory browser for a remote connection — the same
 * flow as the WebUI sidebar's dialog.
 */
export function AddProjectDialog(props: {
	open: Signal<boolean>;
	api: AddProjectApi;
	onAdd: (connectionId: string, path: string) => Promise<Project>;
	/** The target set by the opener; null uses the local connection. */
	connectionId: () => string | null;
	/** Existing projects, used to seed remote directory browsing from a recent parent directory. */
	projects?: () => readonly Project[];
}) {
	const connections = signal<Connection[]>([]);
	const connection = signal<Connection | null>(null);
	const path = signal("");
	const busy = signal(false);
	const picking = signal(false);
	const browserOpen = signal(false);
	const browserPath = signal("/");
	const entries = signal<FsEntry[]>([]);
	const filter = signal("");
	const loadingEntries = signal(false);
	const error = signal<string | null>(null);

	const isLocal = () => connection()?.kind.type === "local";
	// A late response must not update a reopened dialog for another connection.
	let openVersion = 0;
	let browseVersion = 0;
	const directories = computed(() => {
		const query = filter().trim().toLocaleLowerCase();
		return entries().filter(
			(entry) =>
				entry.kind === "directory" &&
				(!query || entry.name.toLocaleLowerCase().includes(query)),
		);
	});

	effect(() => {
		if (!props.open()) return;
		const connectionId = untracked(props.connectionId);
		const version = openVersion;
		connections.set([]);
		connection.set(null);
		path.set("");
		busy.set(false);
		picking.set(false);
		browserOpen.set(false);
		browserPath.set("/");
		entries.set([]);
		filter.set("");
		loadingEntries.set(false);
		error.set(null);
		void props.api.listConnections().then(
			(listed) => {
				if (version !== openVersion) return;
				connections.set(listed);
				const target =
					listed.find((entry) =>
						connectionId === null
							? entry.kind.type === "local"
							: entry.id === connectionId,
					) ?? listed[0];
				if (target) connection.set(target);
				else error.set(t("errors.connectionUnavailable"));
			},
			(caught: unknown) => {
				if (version === openVersion) error.set(errorMessage(caught));
			},
		);
		return () => {
			openVersion += 1;
			browseVersion += 1;
		};
	});

	const add = async () => {
		const target = connection();
		const trimmed = path().trim();
		if (!target || !trimmed || busy() || picking()) return;
		const version = openVersion;
		busy.set(true);
		error.set(null);
		try {
			await props.onAdd(target.id, trimmed);
			if (version === openVersion) props.open.set(false);
		} catch (caught) {
			if (version === openVersion) error.set(errorMessage(caught));
		} finally {
			if (version === openVersion) busy.set(false);
		}
	};

	const loadDirectory = async (nextPath: string): Promise<boolean> => {
		const target = connection();
		if (!target || target.kind.type === "local") return false;
		const version = openVersion;
		const req = ++browseVersion;
		const normalized = absoluteRemotePath(nextPath);
		loadingEntries.set(true);
		error.set(null);
		try {
			const listed = await props.api.readConnectionDir(target.id, normalized);
			if (version !== openVersion || req !== browseVersion) return false;
			entries.set(listed);
			browserPath.set(normalized);
			filter.set("");
			return true;
		} catch (caught) {
			if (version === openVersion && req === browseVersion) {
				error.set(
					`${t("project.readDirectoryFailed")}: ${errorMessage(caught)}`,
				);
			}
			return false;
		} finally {
			if (version === openVersion && req === browseVersion)
				loadingEntries.set(false);
		}
	};

	const initialRemoteBrowsePath = (target: Connection) => {
		const typed = path().trim();
		if (typed.startsWith("/")) return absoluteRemotePath(typed);
		const sameConnection = (props.projects?.() ?? []).filter(
			(p) =>
				p.connection.id === target.id &&
				!isDefaultWorkspace(p) &&
				p.path.startsWith("/"),
		);
		if (sameConnection.length > 0) {
			const recent = [...sameConnection].sort(
				(a, b) => (b.lastOpenedAtMs ?? 0) - (a.lastOpenedAtMs ?? 0),
			)[0];
			if (recent) return parentRemotePath(recent.path);
		}
		return "/";
	};

	const browse = async () => {
		const target = connection();
		if (!target) return;
		if (target.kind.type === "local") {
			const version = openVersion;
			picking.set(true);
			error.set(null);
			try {
				const picked = await props.api.pickLocalProjectDirectory();
				if (picked && version === openVersion) path.set(picked);
			} catch (caught) {
				if (version === openVersion) error.set(errorMessage(caught));
			} finally {
				if (version === openVersion) picking.set(false);
			}
			return;
		}
		if (browserOpen()) {
			browseVersion += 1;
			loadingEntries.set(false);
			browserOpen.set(false);
			return;
		}
		browserOpen.set(true);
		const startPath = initialRemoteBrowsePath(target);
		const ok = await loadDirectory(startPath);
		if (
			!ok &&
			startPath !== "/" &&
			untracked(browserOpen) &&
			untracked(connection)?.id === target.id
		) {
			await loadDirectory("/");
		}
	};

	return (
		<Dialog
			testID="add-project-dialog"
			open={props.open()}
			accessibilityLabel={t("project.addTitle")}
			onOpenChange={({ open }) => props.open.set(open)}
		>
			<DialogHeader>
				<DialogTitle>{() => t("project.addTitle")}</DialogTitle>
				<DialogDescription>
					{() => {
						const target = connection();
						if (!target) return "";
						return t(
							target.kind.type === "local"
								? "project.localDirectory"
								: "project.remoteDirectory",
							{ connection: connectionLabel(target) },
						);
					}}
				</DialogDescription>
			</DialogHeader>
			{() => {
				const list = connections();
				const active = connection();
				if (list.length <= 1 || !active) return null;
				return (
					<View class="gap-1.5">
						<Text class="font-sans text-xs font-medium text-muted-foreground">
							{() => t("project.targetConnection")}
						</Text>
						<Select
							size="sm"
							testID="add-project-connection"
							items={list.map((entry) => ({
								value: entry.id,
								title: connectionLabel(entry),
							}))}
							value={active.id}
							disabled={busy() || picking()}
							onChange={(event) => {
								const next = list.find((entry) => entry.id === event.value);
								if (!next) return;
								browseVersion += 1;
								connection.set(next);
								browserOpen.set(false);
								loadingEntries.set(false);
								browserPath.set("/");
								entries.set([]);
								filter.set("");
								error.set(null);
							}}
						/>
					</View>
				);
			}}
			<View class="gap-1.5">
				<Text class="font-sans text-xs font-medium text-muted-foreground">
					{() => t("project.projectDirectory")}
				</Text>
				<View class="flex-row gap-2">
					<Input
						testID="add-project-path"
						class="flex-1"
						placeholder={isLocal() ? "~/code/project" : "/root/code/project"}
						value={path()}
						disabled={busy()}
						onChange={(event) => path.set(event.value)}
						onSubmit={() => void add()}
					/>
					<Button
						testID="add-project-browse"
						variant="outline"
						size="icon"
						accessibilityLabel={t(
							isLocal() ? "project.browseLocal" : "project.browseRemote",
						)}
						disabled={!connection() || busy() || picking()}
						onPress={() => void browse()}
					>
						<Icon name="FolderOpen" color={token("foreground")} />
					</Button>
				</View>
			</View>
			{() =>
				browserOpen() && !isLocal() ? (
					<View class="overflow-hidden rounded-(--pilo-radius-lg) border border-border">
						<View class="flex-row items-center gap-2 border-b border-border p-2">
							<Button
								testID="add-project-browser-up"
								variant="ghost"
								size="icon"
								class="size-(--pilo-button-sm-height) shrink-0"
								disabled={browserPath() === "/" || loadingEntries()}
								onPress={() =>
									void loadDirectory(parentRemotePath(browserPath()))
								}
							>
								<Icon name="ChevronLeft" color={token("foreground")} />
							</Button>
							<Text
								testID="add-project-browser-path"
								class="flex-1 truncate font-mono text-xs text-foreground"
							>
								{() => browserPath()}
							</Text>
							<Button
								testID="add-project-browser-select"
								variant="secondary"
								size="sm"
								onPress={() => {
									path.set(browserPath());
									browserOpen.set(false);
								}}
							>
								<Text class="font-sans">
									{() => t("project.selectCurrentDirectory")}
								</Text>
							</Button>
						</View>
						<View class="border-b border-border p-2">
							<Input
								testID="add-project-browser-filter"
								placeholder={t("project.filterFolders")}
								value={filter()}
								onChange={(event) => filter.set(event.value)}
							/>
						</View>
						<Scroll
							class="max-h-72"
							contentClass="p-1"
							bounces={false}
							scrollbar={{ mode: "always", vertical: scrollbarLook() }}
						>
							{() =>
								loadingEntries() ? (
									<View class="items-center px-3 py-6">
										<Spinner />
									</View>
								) : directories().length === 0 ? (
									<Text class="font-sans px-3 py-6 text-center text-xs text-muted-foreground">
										{() =>
											filter().trim()
												? t("project.noMatchingFolders", {
														query: filter().trim(),
													})
												: t("project.noFolders")
										}
									</Text>
								) : (
									<Each of={directories()} key={(entry) => entry.path}>
										{(entry) => (
											<Button
												variant="ghost"
												class="w-full justify-start gap-2"
												onPress={() =>
													void loadDirectory(absoluteRemotePath(entry().path))
												}
											>
												<Icon name="Folder" color={token("muted-foreground")} />
												<Text class="font-sans flex-1 truncate">
													{() => entry().name}
												</Text>
											</Button>
										)}
									</Each>
								)
							}
						</Scroll>
					</View>
				) : null
			}
			{() =>
				error() ? (
					<Text
						testID="add-project-error"
						class="font-sans text-xs text-status-danger"
					>
						{() => error()}
					</Text>
				) : null
			}
			<DialogFooter>
				<Button variant="ghost" onPress={() => props.open.set(false)}>
					<Text class="font-sans">{() => t("common.cancel")}</Text>
				</Button>
				<Button
					testID="add-project-confirm"
					disabled={!connection() || busy() || picking() || !path().trim()}
					onPress={() => void add()}
				>
					<Text class="font-sans">
						{() => (busy() ? t("common.adding") : t("common.add"))}
					</Text>
				</Button>
			</DialogFooter>
		</Dialog>
	);
}
