import { openUrl } from "nsh";

import type { DesktopShell } from "../app/shell/desktop-shell";

type DownloadLink = {
	href: string;
	download: string;
	click(): void;
	remove(): void;
};

type BrowserDocument = {
	createElement(tag: "a"): DownloadLink;
	body: { appendChild(link: DownloadLink): void };
};

export const webDesktopShell: DesktopShell = {
	openExternal: openUrl,
	async saveImage(suggestedName, bytes) {
		const { document } = globalThis as { document?: BrowserDocument };
		if (!document?.body) return false;
		const link = document.createElement("a");
		const objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
		try {
			link.href = objectUrl;
			link.download = suggestedName;
			document.body.appendChild(link);
			link.click();
			return true;
		} finally {
			link.remove();
			setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
		}
	},
};
