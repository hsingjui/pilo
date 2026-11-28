import { openUrl } from "nsh";

import type { DesktopShell } from "../app/shell/desktop-shell";
import { browserGlobal } from "./web-remote-browser";

type BrowserDownload = {
	document?: {
		createElement(tag: "a"): { href: string; download: string; click(): void };
	};
	Blob: new (parts: Uint8Array[]) => object;
	URL: {
		createObjectURL(blob: object): string;
		revokeObjectURL(url: string): void;
	};
};

export const webDesktopShell: DesktopShell = {
	openExternal: openUrl,
	async saveImage(name, bytes) {
		const browser = browserGlobal() as unknown as BrowserDownload;
		const link = browser.document?.createElement("a");
		if (!link) return false;
		const url = browser.URL.createObjectURL(new browser.Blob([bytes]));
		link.href = url;
		link.download = name;
		link.click();
		setTimeout(() => browser.URL.revokeObjectURL(url), 1_000);
		return true;
	},
};
