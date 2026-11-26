export function displayProjectPath(path: string): string {
	if (path.startsWith("\\\\?\\UNC\\")) {
		return `\\\\${path.slice(8)}`;
	}
	return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

/**
 * Shortens a filesystem path in the middle so the root/drive and trailing
 * filename stay readable in narrow menus while keeping short paths intact.
 */
export function compactMiddlePath(path: string, maxLength = 38): string {
	const cleaned = displayProjectPath(path);
	if (cleaned.length <= maxLength) return cleaned;
	if (maxLength <= 5) return cleaned.slice(0, maxLength);

	const drive = /^[A-Za-z]:[\\/]/.exec(cleaned)?.[0];
	const sep =
		drive?.[2] ??
		(cleaned.includes("\\") && !cleaned.startsWith("/") ? "\\" : "/");
	let root = "";
	if (drive) {
		root = drive;
	} else if (cleaned.startsWith("\\\\")) {
		root = "\\\\";
	} else if (cleaned.startsWith("~/")) {
		root = "~/";
	} else if (cleaned.startsWith("/")) {
		root = "/";
	}

	const rest = cleaned.slice(root.length);
	const segments = rest
		.split(drive || root === "\\\\" ? /[\\/]/ : sep)
		.filter((segment) => segment.length > 0);
	const head = `${root}…${sep}`;
	const file = segments.at(-1);

	if (!file || maxLength < head.length + 5) {
		const startLen = Math.floor((maxLength - 1) / 2);
		const endLen = maxLength - 1 - startLen;
		return `${cleaned.slice(0, startLen)}…${cleaned.slice(-endLen)}`;
	}

	if (head.length + file.length <= maxLength) {
		let tail = file;
		for (let i = segments.length - 2; i >= 0; i -= 1) {
			const candidate = `${segments[i]}${sep}${tail}`;
			if (head.length + candidate.length > maxLength) break;
			tail = candidate;
		}
		return `${head}${tail}`;
	}

	const budget = maxLength - head.length;
	const startLen = Math.max(1, Math.floor((budget - 1) * 0.45));
	const endLen = Math.max(1, budget - 1 - startLen);
	return `${head}${file.slice(0, startLen)}…${file.slice(-endLen)}`;
}
