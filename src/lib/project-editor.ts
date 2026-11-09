import { invoke, isTauri } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

import type { Project } from "@/lib/api/projects";

export const PROJECT_EDITORS = [
	{ id: "zed", name: "Zed" },
	{ id: "vscode", name: "VS Code" },
	{ id: "cursor", name: "Cursor" },
] as const;

export type ProjectEditor = (typeof PROJECT_EDITORS)[number]["id"];

const PROJECT_OPENERS = [
	...PROJECT_EDITORS,
	{ id: "winc", name: "Winc" },
	{ id: "explorer", name: "File Explorer" },
	{ id: "powershell", name: "PowerShell" },
	{ id: "finder", name: "Finder" },
	{ id: "ghostty", name: "Ghostty" },
] as const;

export type ProjectOpener = (typeof PROJECT_OPENERS)[number]["id"];

export function getProjectOpeners(project: Pick<Project, "connection">) {
	const kind = project.connection.kind.type;
	return PROJECT_OPENERS.filter((opener) => {
		if (opener.id === "explorer" || opener.id === "powershell") {
			return (
				isTauri() &&
				navigator.userAgent.includes("Windows") &&
				(kind === "local" || kind === "wsl")
			);
		}
		if (opener.id === "winc") {
			return (
				isTauri() &&
				(kind === "local" ||
					(kind === "wsl" && navigator.userAgent.includes("Windows")))
			);
		}
		if (opener.id === "finder" || opener.id === "ghostty") {
			return (
				isTauri() && navigator.userAgent.includes("Mac") && kind === "local"
			);
		}
		return true;
	});
}

const STORAGE_KEY = "pilo.projectEditor.v1";
const editorListeners = new Set<() => void>();
let unsavedEditor: (typeof PROJECT_OPENERS)[number] | undefined;

export function readProjectEditor(): (typeof PROJECT_OPENERS)[number] {
	if (typeof window === "undefined") return PROJECT_EDITORS[0];
	if (unsavedEditor) return unsavedEditor;
	try {
		const stored = window.localStorage.getItem(STORAGE_KEY);
		return (
			PROJECT_OPENERS.find((editor) => editor.id === stored) ??
			PROJECT_EDITORS[0]
		);
	} catch {
		return PROJECT_EDITORS[0];
	}
}

export function subscribeProjectEditor(listener: () => void): () => void {
	if (typeof window === "undefined") return () => {};
	const target = window;
	const handleStorage = (event: StorageEvent) => {
		if (event.key === STORAGE_KEY || event.key === null) {
			unsavedEditor = undefined;
			listener();
		}
	};
	editorListeners.add(listener);
	target.addEventListener("storage", handleStorage);
	return () => {
		editorListeners.delete(listener);
		target.removeEventListener("storage", handleStorage);
	};
}

export function writeProjectEditor(editor: ProjectOpener): void {
	if (typeof window === "undefined") return;
	unsavedEditor = PROJECT_OPENERS.find((item) => item.id === editor);
	try {
		window.localStorage.setItem(STORAGE_KEY, editor);
		unsavedEditor = undefined;
	} catch {
		// Keep the choice shared in memory even when persistence is unavailable.
	}
	for (const listener of editorListeners) listener();
}

function encodePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

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
		const encodedAuthority = Array.from(
			new TextEncoder().encode(authority),
			(byte) => byte.toString(16).padStart(2, "0"),
		).join("");
		return `${editor}://vscode-remote/ssh-remote+${encodedAuthority}${encodePath(rootedPath)}`;
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

export async function openProjectInEditor(
	project: Pick<Project, "id" | "path" | "connection">,
	editor: ProjectOpener,
	path?: string,
): Promise<void> {
	if (
		editor === "explorer" ||
		editor === "powershell" ||
		editor === "finder" ||
		editor === "ghostty" ||
		editor === "winc"
	) {
		if (!getProjectOpeners(project).some((opener) => opener.id === editor)) {
			throw new Error("This app is not supported for the current project");
		}
		await invoke<void>("project_open_in_app", {
			id: project.id,
			app: editor,
			path,
		});
		return;
	}
	if (
		isTauri() &&
		navigator.userAgent.includes("Windows") &&
		editor === "zed" &&
		project.connection.kind.type === "wsl"
	) {
		await invoke<void>("project_open_in_zed_wsl", { id: project.id, path });
		return;
	}

	const url = projectEditorUrl(project, editor, path);
	if (isTauri()) {
		await openUrl(url);
	} else {
		// Keep this synchronous with the menu selection for browser user activation.
		window.location.assign(url);
	}
}
