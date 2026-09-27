import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

// The ControlMaster socket directory is a per-process resource that Pi may tear
// down while the process keeps running (reload / session replacement). Deleting
// it must not permanently break the workspace: the next ssh call has to recreate
// it, and ssh's own "unix_listener:" failure must be treated as a transport
// failure instead of a normal non-zero exit.
const sourcePath = new URL(
	"../src-tauri/src/runtime/pi_ssh_workspace.js",
	import.meta.url,
);
const stubPackage = JSON.stringify({
	name: "@earendil-works/pi-coding-agent",
	version: "0.0.0",
	type: "module",
	exports: { ".": "./index.js" },
});
const stubIndex = `const stub = (name) => ({ name, description: name, parameters: {} });
export const createBashToolDefinition = () => stub("bash");
export const createEditToolDefinition = () => stub("edit");
export const createFindToolDefinition = () => stub("find");
export const createGrepToolDefinition = () => stub("grep");
export const createLsToolDefinition = () => stub("ls");
export const createReadToolDefinition = () => stub("read");
export const createWriteToolDefinition = () => stub("write");
`;
const fakeSsh = `#!/bin/sh
STATE="\${PILO_TEST_STATE:?}"
case " $* " in
  *" -O exit "*) exit 0 ;;
esac
if [ -f "$STATE/fail" ]; then
  rm -f "$STATE/fail"
  echo "unix_listener: cannot bind to path /tmp/pilo-ssh-gone/control.abc: No such file or directory" >&2
  exit 255
fi
printf '\\036PILO_SSH_WORKSPACE\\037%s\\037%s\\036' "/home/tester" "/remote/project"
`;

const muxDirs = () => {
	const dir = tmpdir();
	return existsSync(dir)
		? readdirSync(dir).filter((name) => name.startsWith("pilo-ssh-"))
		: [];
};

test("ssh workspace recreates its mux socket dir and fails closed", async (t) => {
	const root = mkdtempSync(path.join(tmpdir(), "pilo-mux-test-"));
	const state = path.join(root, "state");
	const temp = path.join(root, "tmp");
	const stubDir = path.join(
		root,
		"node_modules",
		"@earendil-works",
		"pi-coding-agent",
	);
	const binDir = path.join(root, "bin");
	for (const dir of [state, temp, stubDir, binDir]) {
		mkdirSync(dir, { recursive: true });
	}
	writeFileSync(path.join(stubDir, "package.json"), stubPackage);
	writeFileSync(path.join(stubDir, "index.js"), stubIndex);
	const sshPath = path.join(binDir, "ssh");
	writeFileSync(sshPath, fakeSsh);
	chmodSync(sshPath, 0o755);

	// Keep the run isolated from real pilo-ssh-* dirs, and point the extension's
	// own `ssh` spawn at the fake from before it is imported.
	process.env.PILO_TEST_STATE = state;
	process.env.TMPDIR = temp;
	process.env.PATH = `${binDir}:${process.env.PATH}`;
	t.after(() => {
		rmSync(root, { recursive: true, force: true });
	});

	const source = readFileSync(sourcePath, "utf8").replace(
		"__PILO_SSH_WORKSPACE_CONFIG__",
		JSON.stringify({
			label: "test",
			remoteCwd: "/remote/project",
			sshArgs: ["-o", "BatchMode=yes", "test@host"],
			sshEnvironment: {},
		}),
	);
	const extensionPath = path.join(root, "ext.mjs");
	writeFileSync(extensionPath, source);

	assert.deepEqual(muxDirs(), []);

	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const notifications: string[] = [];
	const statuses: string[] = [];
	const extension = (await import(pathToFileURL(extensionPath).href)).default;
	extension({
		registerTool() {},
		on: (name: string, handler: (...args: unknown[]) => unknown) =>
			handlers.set(name, handler),
	});
	const ctx = {
		ui: {
			setStatus: (key: string, value?: string) =>
				statuses.push(`${key}:${value}`),
			notify: (message: string) => notifications.push(message),
		},
	};
	const startSession = () => handlers.get("session_start")?.({}, ctx);
	const shutdownSession = () => handlers.get("session_shutdown")?.({}, ctx);

	// 1. The first connect fails with a stale ControlMaster socket dir.
	writeFileSync(path.join(state, "fail"), "1");
	await startSession();
	assert.equal(notifications.length, 1);
	assert.match(notifications[0], /unix_listener/);
	const created = muxDirs();
	assert.equal(created.length, 1, "socket dir must be created lazily on use");

	// 2. A foreign session_shutdown deletes the dir while this process keeps
	//    running: the next use must recreate it instead of reusing the dead path.
	const stale = path.join(tmpdir(), created[0]);
	rmSync(stale, { recursive: true, force: true });
	assert.equal(existsSync(stale), false);
	await startSession();
	const recreated = muxDirs();
	assert.equal(recreated.length, 1);
	assert.notEqual(recreated[0], created[0]);
	assert.ok(
		statuses.some((value) => value.startsWith("pilo-ssh-workspace:SSH")),
		"second session must report connected",
	);

	// 3. Shutdown releases the dir; a later session in the same process must get a
	//    fresh dir and still fail closed on transport errors.
	await shutdownSession();
	assert.deepEqual(muxDirs(), []);
	writeFileSync(path.join(state, "fail"), "1");
	await startSession();
	assert.equal(notifications.length, 2);
	assert.equal(muxDirs().length, 1);
});
