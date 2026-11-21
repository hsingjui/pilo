import { computed, type Signal, signal, Text, token, View } from "nsh";

import type { FsEntry } from "@shared/api/files-types";
import type { Connection } from "@shared/api/pi-runtime-types";
import type { Project } from "@shared/api/projects-types";
import type { NshPiloClient } from "../client/nsh-pilo-client";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogDescription } from "../ui/dialog-description";
import { DialogFooter } from "../ui/dialog-footer";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { Icon } from "../ui/icon";
import { Input } from "../ui/input";
import { Select } from "../ui/select";
import { Spinner } from "../ui/spinner";
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

function connectionLabel(connection: Connection) {
	return connection.kind.type === "local" ? t("common.local") : connection.name;
}

function errorMessage(error: unknown) {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Adds a project on a connection: a typed path, the host's folder picker for
 * Local, or an inline directory browser for a remote connection — the same
 * flow as the Tauri sidebar's dialog.
 */
export function AddProjectDialog(props: {
	open: Signal<boolean>;
	api: AddProjectApi;
	onAdd: (connectionId: string, path: string) => Promise<Project>;
	/** The connection the dialog opens on (a connection row's +). */
	initialConnectionId?: () => string | null;
}) {
	const connections = signal<Connection[]>([]);
	const connectionId = signal<string | null>(null);
	const path = signal("");
	const busy = signal(false);
	const picking = signal(false);
	const browserOpen = signal(false);
	const browserPath = signal("/");
	const entries = signal<FsEntry[]>([]);
	const filter = signal("");
	const loadingEntries = signal(false);
	const error = signal<string | null>(null);

	const connection = () =>
		connections().find((entry) => entry.id === connectionId()) ??
		connections()[0] ??
		null;
	const isLocal = () => connection()?.kind.type === "local";
	const directories = computed(() => {
		const query = filter().trim().toLocaleLowerCase();
		return entries().filter(
			(entry) =>
				entry.kind === "directory" &&
				(!query || entry.name.toLocaleLowerCase().includes(query)),
		);
	});

	const reset = async () => {
		path.set("");
		busy.set(false);
		picking.set(false);
		browserOpen.set(false);
		browserPath.set("/");
		entries.set([]);
		filter.set("");
		error.set(null);
		try {
			const listed = await props.api.listConnections();
			connections.set(listed);
			const preferred = props.initialConnectionId?.() ?? null;
			connectionId.update((current) => {
				const wanted = preferred ?? current;
				return wanted !== null && listed.some((entry) => entry.id === wanted)
					? wanted
					: (listed[0]?.id ?? null);
			});
		} catch (caught) {
			error.set(errorMessage(caught));
		}
	};

	const add = async () => {
		const target = connection();
		const trimmed = path().trim();
		if (!target || !trimmed || busy() || picking()) return;
		busy.set(true);
		error.set(null);
		try {
			await props.onAdd(target.id, trimmed);
			props.open.set(false);
		} catch (caught) {
			error.set(errorMessage(caught));
		} finally {
			busy.set(false);
		}
	};

	const loadDirectory = async (nextPath: string) => {
		const target = connection();
		if (!target || isLocal()) return;
		const normalized = absoluteRemotePath(nextPath);
		loadingEntries.set(true);
		error.set(null);
		try {
			entries.set(await props.api.readConnectionDir(target.id, normalized));
			browserPath.set(normalized);
			filter.set("");
		} catch (caught) {
			error.set(`${t("project.readDirectoryFailed")}: ${errorMessage(caught)}`);
		} finally {
			loadingEntries.set(false);
		}
	};

	const browse = async () => {
		if (isLocal()) {
			picking.set(true);
			error.set(null);
			try {
				const picked = await props.api.pickLocalProjectDirectory();
				if (picked) path.set(picked);
			} catch (caught) {
				error.set(errorMessage(caught));
			} finally {
				picking.set(false);
			}
			return;
		}
		if (browserOpen()) {
			browserOpen.set(false);
			return;
		}
		browserOpen.set(true);
		await loadDirectory("/");
	};

	return (
		<Dialog
			testID="add-project-dialog"
			open={props.open()}
			accessibilityLabel={t("project.addTitle")}
			onOpenChange={({ open }) => props.open.set(open)}
			onOpen={() => void reset()}
		>
			<DialogHeader>
				<DialogTitle>{() => t("project.addTitle")}</DialogTitle>
				<DialogDescription>
					{() =>
						t(
							isLocal() ? "project.localDirectory" : "project.remoteDirectory",
							{
								connection: connection() ? connectionLabel(connection()!) : "",
							},
						)
					}
				</DialogDescription>
			</DialogHeader>
			<View class="gap-1.5">
				<Text class="font-sans text-xs font-medium text-muted-foreground">
					{() => t("project.addTitle")}
				</Text>
				<Select
					testID="add-project-connection"
					items={connections().map((entry) => ({
						value: entry.id,
						title: `${entry.name} · ${connectionLabel(entry)}`,
					}))}
					value={connectionId()}
					disabled={busy()}
					onChange={(event) => connectionId.set(event.value)}
				/>
			</View>
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
						disabled={busy() || picking()}
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
						<View class="max-h-72 p-1">
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
						</View>
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
					disabled={busy() || picking() || !path().trim()}
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
