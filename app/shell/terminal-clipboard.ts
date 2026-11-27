export const SIGINT_BYTES = new Uint8Array([0x03]);

/**
 * Formats clipboard text for a PTY, matching `nsh/base`'s `Terminal` paste
 * behavior: normalize line endings to CR and wrap with DECSET 2004 markers
 * while the running program has bracketed paste enabled.
 */
export function encodeTerminalPaste(
	text: string,
	bracketedPaste: boolean,
): string {
	const normalized = text.replace(/\r\n|\n/g, "\r");
	return bracketedPaste ? `\x1b[200~${normalized}\x1b[201~` : normalized;
}

type ParserState = "ground" | "esc" | "csi";

/**
 * Tracks whether the terminal program currently has bracketed paste mode
 * (`CSI ? 2004 h` / `CSI ? 2004 l`) enabled across streamed output chunks.
 */
export class TerminalBracketedPasteTracker {
	private state: ParserState = "ground";
	private csi = "";
	private enabled = false;

	get active(): boolean {
		return this.enabled;
	}

	feed(chunk: string): void {
		for (let i = 0; i < chunk.length; i += 1) {
			const code = chunk.charCodeAt(i);
			if (this.state === "ground") {
				if (code === 0x1b) this.state = "esc";
				continue;
			}
			if (this.state === "esc") {
				if (code === 0x5b) {
					// `[` -> CSI
					this.state = "csi";
					this.csi = "";
				} else if (code === 0x63) {
					// `ESC c` -> full terminal reset (RIS)
					this.enabled = false;
					this.state = "ground";
				} else if (code === 0x1b) {
					this.state = "esc";
				} else {
					this.state = "ground";
				}
				continue;
			}
			// CSI parameters (0x30..=0x3f) and intermediates (0x20..=0x2f)
			if (code >= 0x20 && code <= 0x3f) {
				if (this.csi.length < 64) this.csi += chunk[i];
				continue;
			}
			// Final byte (0x40..=0x7e) ends CSI
			if (code >= 0x40 && code <= 0x7e) {
				if (
					(code === 0x68 || code === 0x6c) && // `h` or `l`
					this.csi.startsWith("?")
				) {
					const params = this.csi.slice(1).split(";");
					// nsh parses CSI parameters as numbers, so leading zeroes are valid.
					if (params.some((param) => /^0*2004$/.test(param))) {
						this.enabled = code === 0x68;
					}
				}
				this.state = "ground";
				this.csi = "";
				continue;
			}
			if (code === 0x1b) {
				this.state = "esc";
				this.csi = "";
			} else if (code < 0x20 || code === 0x7f) {
				// Ignore C0/DEL inside CSI without aborting.
			} else {
				this.state = "ground";
				this.csi = "";
			}
		}
	}
}
