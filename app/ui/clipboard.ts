import { Clipboard } from "nsh";

export async function writeClipboardText(text: string): Promise<void> {
	// Some platforms can only report that the write was requested.
	if ((await Clipboard.writeText(text)) === "failed") {
		throw new Error("The system refused the clipboard write");
	}
}
