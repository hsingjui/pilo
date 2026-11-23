const BASE64_ALPHABET =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Encodes raw bytes to standard Base64 without relying on DOM globals. */
export function bytesToBase64(bytes: Uint8Array): string {
	const chunks: string[] = [];
	const chunkSize = 0x6000; // multiple of 3 bytes (24 KB)
	for (let offset = 0; offset < bytes.length; offset += chunkSize) {
		const end = Math.min(offset + chunkSize, bytes.length);
		let part = "";
		let i = offset;
		for (; i + 2 < end; i += 3) {
			const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
			part +=
				BASE64_ALPHABET[(n >>> 18) & 63]! +
				BASE64_ALPHABET[(n >>> 12) & 63]! +
				BASE64_ALPHABET[(n >>> 6) & 63]! +
				BASE64_ALPHABET[n & 63]!;
		}
		const remaining = end - i;
		if (remaining === 1) {
			const n = bytes[i]! << 16;
			part +=
				BASE64_ALPHABET[(n >>> 18) & 63]! +
				BASE64_ALPHABET[(n >>> 12) & 63]! +
				"==";
		} else if (remaining === 2) {
			const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
			part +=
				BASE64_ALPHABET[(n >>> 18) & 63]! +
				BASE64_ALPHABET[(n >>> 12) & 63]! +
				BASE64_ALPHABET[(n >>> 6) & 63]! +
				"=";
		}
		chunks.push(part);
	}
	return chunks.join("");
}
