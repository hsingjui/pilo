export function displayProjectPath(path: string): string {
	if (path.startsWith("\\\\?\\UNC\\")) {
		return `\\\\${path.slice(8)}`;
	}
	return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}
