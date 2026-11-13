import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { runInNewContext } from "node:vm";

// Evaluate the production extension with isolated imports, not the legacy copy.
const source = readFileSync(
	new URL(
		"../../crates/pilo-server/extensions/ssh-workspace.js",
		import.meta.url,
	),
	"utf8",
)
	.replace(/^import[\s\S]*?from "[^"]+";\n/gm, "")
	.replace(
		"export default function piloSshWorkspace",
		"function piloSshWorkspace",
	);
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

const stub = (name: string) => ({ name, description: name, parameters: {} });

function loadExtension(t: TestContext, platform: "darwin" | "linux") {
	const root = mkdtempSync(path.join(tmpdir(), "pilo-mux-test-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const state = path.join(root, "state");
	const sockets = path.join(root, "sockets");
	const binDir = path.join(root, "bin");
	for (const dir of [state, sockets, binDir]) mkdirSync(dir);
	const sshPath = path.join(binDir, "ssh");
	writeFileSync(sshPath, fakeSsh);
	chmodSync(sshPath, 0o755);

	const longTmp = `/private/var/folders/${"x".repeat(100)}/T`;
	const muxRoot = platform === "darwin" ? "/tmp" : longTmp;
	// Redirect every extension filesystem call into this fixture. In particular,
	// pruning /tmp must never inspect or remove real Pilo session directories.
	const localPath = (value: string) => {
		assert.ok(value === muxRoot || value.startsWith(`${muxRoot}/`));
		return path.join(sockets, path.posix.relative(muxRoot, value));
	};
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const socketPaths: string[] = [];
	const notifications: string[] = [];
	const statuses: string[] = [];
	runInNewContext(`${source}\npiloSshWorkspace(pi);`, {
		process: {
			platform,
			cwd: () => root,
			env: {
				...process.env,
				PATH: `${binDir}:${process.env.PATH}`,
				TMPDIR: longTmp,
				PILO_TEST_STATE: state,
				PILO_SSH_FORCE_PERSISTENT: "0",
				PILO_SSH_WORKSPACE_CONFIG: JSON.stringify({
					label: "test",
					remoteCwd: "/remote/project",
					sshArgs: ["-o", "BatchMode=yes", "test@host"],
					sshEnvironment: {},
				}),
			},
		},
		path: path.posix,
		tmpdir: () => longTmp,
		existsSync: (value: string) => existsSync(localPath(value)),
		mkdtempSync: (value: string) =>
			path.posix.join(muxRoot, path.basename(mkdtempSync(localPath(value)))),
		readdirSync: (value: string) =>
			readdirSync(localPath(value), { withFileTypes: true }),
		statSync: (value: string) => statSync(localPath(value)),
		rmSync: (value: string) =>
			rmSync(localPath(value), { recursive: true, force: true }),
		spawn: (command: string, args: string[], options: SpawnOptions) => {
			const index = args.indexOf("-S");
			assert.notEqual(index, -1, "SSH must use a ControlMaster socket");
			socketPaths.push(args[index + 1]);
			return spawn(command, args, options);
		},
		Buffer,
		setTimeout,
		clearTimeout,
		createBashToolDefinition: () => stub("bash"),
		createEditToolDefinition: () => stub("edit"),
		createFindToolDefinition: () => stub("find"),
		createGrepToolDefinition: () => stub("grep"),
		createLsToolDefinition: () => stub("ls"),
		createReadToolDefinition: () => stub("read"),
		createWriteToolDefinition: () => stub("write"),
		pi: {
			registerTool() {},
			on: (name: string, handler: (...args: unknown[]) => unknown) =>
				handlers.set(name, handler),
		},
	});
	const ctx = {
		ui: {
			setStatus: (key: string, value?: string) =>
				statuses.push(`${key}:${value}`),
			notify: (message: string) => notifications.push(message),
		},
	};
	return {
		state,
		sockets,
		muxRoot,
		longTmp,
		socketPaths,
		notifications,
		statuses,
		dirs: () =>
			readdirSync(sockets).filter((name) => name.startsWith("pilo-ssh-")),
		start: () => handlers.get("session_start")?.({}, ctx),
		shutdown: () => handlers.get("session_shutdown")?.({}, ctx),
	};
}

for (const platform of ["darwin", "linux"] as const) {
	test(
		`${platform}: production SSH workspace recreates mux directories and fails closed`,
		{ skip: process.platform === "win32" },
		async (t) => {
			const fixture = loadExtension(t, platform);
			assert.deepEqual(fixture.dirs(), [], "socket directory is lazy");

			writeFileSync(path.join(fixture.state, "fail"), "1");
			await fixture.start();
			assert.equal(fixture.notifications.length, 1);
			assert.match(fixture.notifications[0], /unix_listener/);
			const created = fixture.dirs();
			assert.equal(created.length, 1);
			assert.equal(
				path.posix.dirname(fixture.socketPaths[0]),
				path.posix.join(fixture.muxRoot, created[0]),
			);
			if (platform === "darwin") {
				assert.ok(Buffer.byteLength(fixture.longTmp) > 104);
				// OpenSSH appends a temporary suffix when binding sun_path (104 bytes).
				assert.ok(
					Buffer.byteLength(`${fixture.socketPaths[0]}.XXXXXXXXXX`) < 104,
				);
			}

			const stale = path.join(fixture.sockets, created[0]);
			rmSync(stale, { recursive: true, force: true });
			await fixture.start();
			const recreated = fixture.dirs();
			assert.equal(recreated.length, 1);
			assert.notEqual(recreated[0], created[0]);
			assert.ok(
				fixture.statuses.some((value) =>
					value.startsWith("pilo-ssh-workspace:SSH"),
				),
				"reconnection must report connected",
			);

			await fixture.shutdown();
			assert.deepEqual(fixture.dirs(), []);
			writeFileSync(path.join(fixture.state, "fail"), "1");
			await fixture.start();
			assert.equal(fixture.notifications.length, 2);
			assert.equal(fixture.dirs().length, 1);
			await fixture.shutdown();
			assert.deepEqual(fixture.dirs(), []);
		},
	);
}

test(
	"macOS prunes stale mux directories only in its isolated short socket root",
	{ skip: process.platform === "win32" },
	async (t) => {
		const fixture = loadExtension(t, "darwin");
		const stale = path.join(fixture.sockets, "pilo-ssh-stale");
		const fresh = path.join(fixture.sockets, "pilo-ssh-fresh");
		const unrelated = path.join(fixture.sockets, "other-directory");
		for (const dir of [stale, fresh, unrelated]) mkdirSync(dir);
		const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
		utimesSync(stale, old, old);
		utimesSync(unrelated, old, old);

		await fixture.start();
		assert.deepEqual(fixture.notifications, []);
		assert.equal(existsSync(stale), false);
		assert.equal(existsSync(fresh), true);
		assert.equal(existsSync(unrelated), true);
		await fixture.shutdown();
		assert.deepEqual(fixture.dirs(), ["pilo-ssh-fresh"]);
	},
);
