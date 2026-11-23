import { openUrl, platform, signal, Storage } from "nsh";

import type { Project } from "@shared/api/projects-types";
import type { ProjectNativeApp } from "../client/nsh-pilo-client";

/** The editors a project opens in through their URL schemes. */
const PROJECT_EDITORS = [
	{ id: "zed", name: "Zed" },
	{ id: "vscode", name: "VS Code" },
	{ id: "cursor", name: "Cursor" },
] as const;

export type ProjectEditor = (typeof PROJECT_EDITORS)[number]["id"];

/** Every app the quick-open menu offers, in the WebUI's order. */
const PROJECT_OPENERS = [
	...PROJECT_EDITORS,
	{ id: "winc", name: "Winc" },
	{ id: "explorer", name: "File Explorer" },
	{ id: "powershell", name: "PowerShell" },
	{ id: "finder", name: "Finder" },
	{ id: "ghostty", name: "Ghostty" },
] as const;

export type ProjectOpener = (typeof PROJECT_OPENERS)[number];
export type ProjectOpenerId = ProjectOpener["id"];

/**
 * The WebUI's localStorage key. nsh's `Storage` is not the WebView's
 * localStorage, so the app the WebUI saved does not carry over.
 */
const STORAGE_KEY = "pilo.projectEditor.v1";

/** The apps the project can open in on this platform and connection. */
export function projectOpeners(
	project: Pick<Project, "connection">,
): ProjectOpener[] {
	const kind = project.connection.kind.type;
	return PROJECT_OPENERS.filter((opener) => {
		switch (opener.id) {
			case "explorer":
			case "powershell":
				return (
					platform.os === "windows" && (kind === "local" || kind === "wsl")
				);
			case "winc":
				return (
					kind === "local" || (kind === "wsl" && platform.os === "windows")
				);
			case "finder":
			case "ghostty":
				return platform.os === "macos" && kind === "local";
			default:
				return true;
		}
	});
}

/** Whether the app opens a folder rather than the file itself. */
export function opensDirectory(opener: ProjectOpenerId) {
	return (
		opener === "explorer" ||
		opener === "finder" ||
		opener === "powershell" ||
		opener === "ghostty"
	);
}

const chosen = signal<ProjectOpenerId | null>(null);
let loading: Promise<void> | undefined;

/** The app the user last opened a project in; Zed until they chose one. */
export function chosenProjectOpener(): ProjectOpenerId {
	loading ??= Storage.getItem(STORAGE_KEY)
		.then((stored) => {
			const opener = PROJECT_OPENERS.find(({ id }) => id === stored);
			if (opener && chosen() === null) chosen.set(opener.id);
		})
		.catch((error: unknown) => {
			console.warn("Failed to read the chosen project app", error);
		});
	return chosen() ?? PROJECT_EDITORS[0].id;
}

/** Remembers the app for the next quick open, also across launches. */
export function chooseProjectOpener(opener: ProjectOpenerId) {
	chosen.set(opener);
	void Storage.setItem(STORAGE_KEY, opener).catch((error: unknown) => {
		console.warn("Failed to save the chosen project app", error);
	});
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function utf8Hex(text: string): string {
	return Array.from(new TextEncoder().encode(text), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

/**
 * The URL that opens the project, or a path in it, in an editor: a local
 * folder, Zed's and VS Code Remote's WSL and SSH targets, as the WebUI
 * builds them.
 */
export function projectEditorUrl(
	project: Pick<Project, "path" | "connection">,
	editor: ProjectEditor,
	targetPath = project.path,
): string {
	const kind = project.connection.kind;
	const windowsPath =
		kind.type === "local" && /^(?:[a-z]:[\\/]|\\\\)/i.test(targetPath);
	const path = windowsPath
		? targetPath
				.replace(/\\/g, "/")
				.replace(/^\/\/\?\/UNC\//i, "//")
				.replace(/^\/\/\?\//, "")
		: targetPath;
	const rootedPath = path.startsWith("/") ? path : `/${path}`;

	if (kind.type === "ssh") {
		const target = kind.target;
		const host = target.type === "config_host" ? target.host : target.hostname;
		if (editor === "zed") {
			const hostname =
				host.includes(":") && !host.startsWith("[")
					? `[${host}]`
					: encodeURIComponent(host)
							.replace(/%3A/gi, ":")
							.replace(/%5B/gi, "[")
							.replace(/%5D/gi, "]");
			const user =
				target.type === "direct" && target.user
					? `${encodeURIComponent(target.user)}@`
					: "";
			const port =
				target.type === "direct" && target.port ? `:${target.port}` : "";
			return `zed://ssh/${user}${hostname}${port}${encodePath(rootedPath)}`;
		}
		// Remote-SSH accepts a UTF-8 hex JSON authority, preserving user and port.
		const authority = JSON.stringify({
			hostName: host,
			...(target.type === "direct" && target.user ? { user: target.user } : {}),
			...(target.type === "direct" && target.port ? { port: target.port } : {}),
		});
		return `${editor}://vscode-remote/ssh-remote+${utf8Hex(authority)}${encodePath(rootedPath)}`;
	}

	if (kind.type === "wsl") {
		if (editor === "zed") {
			return `zed://file//wsl.localhost/${encodeURIComponent(kind.distro)}${encodePath(rootedPath)}`;
		}
		return `${editor}://vscode-remote/wsl+${encodeURIComponent(kind.distro)}${encodePath(rootedPath)}`;
	}

	// Zed strips "zed://file" literally; Windows drive paths must not gain a slash.
	if (editor === "zed") return `zed://file${encodePath(path)}`;
	return `${editor}://file${encodePath(rootedPath)}`;
}

/** Opens the project, or a path in it, in the app. */
export async function openProject(
	project: Pick<Project, "id" | "path" | "connection">,
	opener: ProjectOpenerId,
	openInApp: (
		projectId: string,
		app: ProjectNativeApp,
		path?: string,
	) => Promise<void>,
	path?: string,
): Promise<void> {
	if (!projectOpeners(project).some(({ id }) => id === opener)) {
		throw new Error("This app is not supported for the current project");
	}
	if (opener === "zed" || opener === "vscode" || opener === "cursor") {
		const { opened } = await openUrl(projectEditorUrl(project, opener, path));
		if (!opened) throw new Error(`No app opens ${opener} links`);
		return;
	}
	await openInApp(project.id, opener, path);
}
