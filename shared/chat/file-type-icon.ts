/** 文件类型分类，用于为文件引用、附件与消息气泡提供区分图标与语义色。 */
export type FileTypeKind =
	| "react"
	| "typescript"
	| "javascript"
	| "rust"
	| "python"
	| "go"
	| "json"
	| "markdown"
	| "style"
	| "markup"
	| "config"
	| "shell"
	| "database"
	| "image"
	| "archive"
	| "code"
	| "file";

const SPECIAL_FILE_NAMES: Readonly<Record<string, FileTypeKind>> = {
	dockerfile: "config",
	makefile: "shell",
	justfile: "shell",
	"cargo.toml": "config",
	"cargo.lock": "config",
	"package.json": "json",
	"tsconfig.json": "json",
	".gitignore": "config",
	".gitattributes": "config",
	".editorconfig": "config",
	".npmrc": "config",
	".env": "config",
	".env.local": "config",
	".env.example": "config",
	readme: "markdown",
	license: "markdown",
};

const EXTENSION_KIND: Readonly<Record<string, FileTypeKind>> = {
	tsx: "react",
	jsx: "react",
	ts: "typescript",
	mts: "typescript",
	cts: "typescript",
	js: "javascript",
	mjs: "javascript",
	cjs: "javascript",
	rs: "rust",
	py: "python",
	pyi: "python",
	pyw: "python",
	go: "go",
	json: "json",
	jsonc: "json",
	json5: "json",
	jsonl: "json",
	md: "markdown",
	mdx: "markdown",
	markdown: "markdown",
	txt: "markdown",
	rst: "markdown",
	css: "style",
	scss: "style",
	sass: "style",
	less: "style",
	styl: "style",
	html: "markup",
	htm: "markup",
	xml: "markup",
	svg: "markup",
	yaml: "config",
	yml: "config",
	toml: "config",
	ini: "config",
	conf: "config",
	cfg: "config",
	env: "config",
	lock: "config",
	properties: "config",
	sh: "shell",
	bash: "shell",
	zsh: "shell",
	fish: "shell",
	ps1: "shell",
	bat: "shell",
	cmd: "shell",
	sql: "database",
	db: "database",
	sqlite: "database",
	sqlite3: "database",
	csv: "database",
	tsv: "database",
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	ico: "image",
	bmp: "image",
	avif: "image",
	heic: "image",
	zip: "archive",
	tar: "archive",
	gz: "archive",
	tgz: "archive",
	bz2: "archive",
	xz: "archive",
	rar: "archive",
	"7z": "archive",
	c: "code",
	h: "code",
	cc: "code",
	cpp: "code",
	cxx: "code",
	hpp: "code",
	cs: "code",
	java: "code",
	kt: "code",
	kts: "code",
	swift: "code",
	m: "code",
	mm: "code",
	rb: "code",
	php: "code",
	vue: "code",
	svelte: "code",
	astro: "code",
	lua: "code",
	zig: "code",
	proto: "code",
	graphql: "code",
	gql: "code",
	dart: "code",
	ex: "code",
	exs: "code",
	erl: "code",
	hs: "code",
	ml: "code",
	scala: "code",
	r: "code",
	wgsl: "code",
	glsl: "code",
};

/** 按路径或文件名识别文件类型；无法归类时回退到 `"file"`。 */
export function classifyFileType(pathOrName: string): FileTypeKind {
	const name = (pathOrName.split(/[\\/]/).pop() ?? pathOrName)
		.trim()
		.toLowerCase();
	if (!name) return "file";
	const exact = SPECIAL_FILE_NAMES[name];
	if (exact) return exact;
	if (name.startsWith(".env.")) return "config";
	if (name.startsWith("dockerfile.")) return "config";
	if (
		name.endsWith(".d.ts") ||
		name.endsWith(".d.mts") ||
		name.endsWith(".d.cts")
	)
		return "typescript";
	const dot = name.lastIndexOf(".");
	if (dot <= 0 || dot === name.length - 1) return "file";
	const ext = name.slice(dot + 1);
	return EXTENSION_KIND[ext] ?? "file";
}
