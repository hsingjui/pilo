import { platform, signal } from "nsh";

/**
 * The Host whose Connections, Projects and Sessions the window shows: the
 * embedded Host (this machine) or a remote one, named and described from
 * that Host's point of view.
 */
export type HostPerspective = {
	/** The remote Host's name; `null` for this machine's embedded Host. */
	remoteName: string | null;
	/** The Host's platform (`macos`, `windows`, `linux`), which decides WSL. */
	platform: string;
};

const LOCAL_PERSPECTIVE: HostPerspective = {
	remoteName: null,
	platform: platform.os,
};

const current = signal<HostPerspective>(LOCAL_PERSPECTIVE);

/** The shown Host's perspective (reactive). */
export function hostPerspective(): HostPerspective {
	return current();
}

export function setHostPerspective(next: HostPerspective | null): void {
	current.set(next ?? LOCAL_PERSPECTIVE);
}

/** Whether the shown Host runs on Windows, where WSL connections exist. */
export function hostSupportsWsl(): boolean {
	return current().platform === "windows";
}
