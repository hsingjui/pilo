// The web-platform globals shared code may use: the browser (WebUI) and the
// nsh engine (desktop) both provide them. Only `tsc -p shared` reads this file,
// so a DOM, React or nsh API used here fails the shared type check.

declare const console: {
	debug(...data: unknown[]): void;
	error(...data: unknown[]): void;
	info(...data: unknown[]): void;
	log(...data: unknown[]): void;
	warn(...data: unknown[]): void;
};

declare function setTimeout(handler: () => void, timeout?: number): number;
declare function clearTimeout(id: number | undefined): void;

declare const crypto: {
	getRandomValues<T extends ArrayBufferView>(array: T): T;
	randomUUID?(): string;
};

declare class URLSearchParams {
	constructor(init?: string | Record<string, string>);
	get(name: string): string | null;
	has(name: string): boolean;
	set(name: string, value: string): void;
	delete(name: string): void;
	toString(): string;
}

declare class URL {
	constructor(url: string, base?: string | URL);
	hash: string;
	host: string;
	hostname: string;
	href: string;
	readonly origin: string;
	password: string;
	pathname: string;
	port: string;
	protocol: string;
	search: string;
	readonly searchParams: URLSearchParams;
	username: string;
}

declare class File {
	readonly name: string;
	readonly size: number;
	readonly type: string;
}
