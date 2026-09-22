import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";

const config = __PILO_SSH_WORKSPACE_CONFIG__;
const localCwd = process.cwd();
const supportedImageTypes = new Set([
	"image/bmp",
	"image/gif",
	"image/jpeg",
	"image/png",
	"image/webp",
]);
const maxSearchBytes = 64 * 1024;
const workspaceFrame = "\x1ePILO_SSH_WORKSPACE\x1f";
// Windows OpenSSH has no ControlMaster multiplexing, so on win32 we keep one
// long-lived ssh process and pipe commands through it. POSIX keeps ControlMaster.
// PILO_SSH_FORCE_PERSISTENT forces the session path (used to exercise it in tests).
const persistentTransport =
	process.platform === "win32" || process.env.PILO_SSH_FORCE_PERSISTENT === "1";
const muxDir =
	process.platform === "win32"
		? undefined
		: mkdtempSync(path.join(tmpdir(), "pilo-ssh-"));
const muxPath = muxDir ? path.join(muxDir, "control") : undefined;
let runtime = { kind: "connecting" };
let shuttingDown = false;
let reconnectPromise;
let remoteHome;

function shellQuote(value) {
	return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

function sshEnvironment() {
	return { ...process.env, ...config.sshEnvironment };
}

function sshArgs() {
	const args = [...config.sshArgs];
	if (!muxPath || args.length === 0) return args;
	const destination = args.pop();
	args.push(
		"-o",
		"ControlMaster=auto",
		"-o",
		"ControlPersist=10m",
		"-S",
		muxPath,
		destination,
	);
	return args;
}

function remoteSessionExports(env) {
	if (!env) return "";
	const assignments = [];
	for (const key of [
		"PI_SESSION_ID",
		"PI_PROVIDER",
		"PI_MODEL",
		"PI_REASONING_LEVEL",
	]) {
		if (typeof env[key] === "string") {
			assignments.push(`${key}=${shellQuote(env[key])}`);
		}
	}
	return assignments.length ? `export ${assignments.join(" ")}; ` : "";
}

function toRemote(localPath) {
	const absolute = path.resolve(localPath);
	const relative = path.relative(localCwd, absolute);
	if (!relative) return config.remoteCwd;
	if (
		relative !== ".." &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	) {
		return path.posix.resolve(
			config.remoteCwd,
			relative.split(path.sep).join("/"),
		);
	}

	// Pi resolves tool paths with the local platform path implementation before
	// calling Operations. On Windows, /etc/hosts becomes C:\\etc\\hosts; map it
	// back to a POSIX absolute path before sending it to the remote host.
	if (process.platform === "win32") {
		const root = path.parse(absolute).root;
		const posixAbsolute = absolute.slice(root.length).split(path.sep).join("/");
		return path.posix.resolve("/", posixAbsolute);
	}
	return path.posix.normalize(absolute);
}

function resolveRemoteInput(input, cwd = localCwd) {
	let value = String(input || ".");
	if (value.startsWith("@")) value = value.slice(1);
	if (value === "~") {
		if (!remoteHome) throw new Error("Remote HOME is not available");
		return remoteHome;
	}
	if (value.startsWith("~/")) {
		if (!remoteHome) throw new Error("Remote HOME is not available");
		return path.posix.resolve(remoteHome, value.slice(2));
	}
	if (value.startsWith("~")) {
		throw new Error(`Remote ~user paths are not supported: ${value}`);
	}
	if (value.startsWith("/")) return path.posix.normalize(value);
	return path.posix.resolve(toRemote(cwd), value);
}

const sshTransportFailurePatterns = [
	/^ssh:/m,
	/^mux_client_/m,
	/^kex_exchange_identification:/m,
	/^channel \d+:/m,
	/permission denied/i,
	/could not resolve hostname/i,
	/host key verification failed/i,
	/remote host identification has changed/i,
	/connection (closed|refused|reset|timed out)/i,
	/no route to host/i,
	/broken pipe/i,
	/killed by signal/i,
];

function looksLikeTransportFailure(stderrText) {
	return sshTransportFailurePatterns.some((pattern) =>
		pattern.test(stderrText),
	);
}

function failTransport(stderr) {
	const detail = stderr.trim() || "ssh exited with code 255";
	runtime = { kind: "failed", error: detail };
	return new Error(`SSH workspace unavailable: ${detail}`);
}

function failureDetail(error) {
	const message = error instanceof Error ? error.message : String(error);
	return message.replace(/^SSH workspace unavailable:\s*/, "");
}

function requireActive() {
	if (runtime.kind === "active") return;
	if (runtime.kind === "connecting") {
		throw new Error(`SSH workspace is still connecting to ${config.label}`);
	}
	throw new Error(`SSH workspace unavailable: ${runtime.error}`);
}

function runSsh(command, options = {}) {
	if (!options.allowConnecting) requireActive();
	if (persistentTransport) return runSession(command, options);
	return runSshOnce(command, options);
}

function runSshOnce(command, options = {}) {
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}

		const child = spawn("ssh", [...sshArgs(), command], {
			env: sshEnvironment(),
			windowsHide: true,
			stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
		});
		const stdout = [];
		const stderr = [];
		let timedOut = false;
		let timeoutHandle;

		const onAbort = () => child.kill();
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.timeoutSeconds) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				child.kill();
			}, options.timeoutSeconds * 1000);
		}

		if (options.input !== undefined) {
			child.stdin?.on("error", () => {});
			child.stdin?.end(options.input);
		}
		child.stdout.on("data", (chunk) => {
			if (options.onData) options.onData(chunk);
			else stdout.push(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr.push(chunk);
			if (options.onData) options.onData(chunk);
		});
		child.on("error", (error) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", onAbort);
			if (!shuttingDown) {
				runtime = { kind: "failed", error: error.message };
			}
			reject(new Error(`SSH workspace unavailable: ${error.message}`));
		});
		child.on("close", (code) => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", onAbort);
			if (options.signal?.aborted) {
				reject(new Error("Operation aborted"));
				return;
			}
			if (timedOut) {
				reject(
					new Error(`SSH command timed out after ${options.timeoutSeconds}s`),
				);
				return;
			}
			const stdoutBuffer = Buffer.concat(stdout);
			const stderrBuffer = Buffer.concat(stderr);
			const stderrText = stderrBuffer.toString("utf8");
			// ssh reports transport failures as exit code 255, but a remote command
			// may also legitimately exit 255. Streaming bash never buffers stdout,
			// so match ssh's own stderr instead of stdout emptiness; otherwise any
			// command exiting 255 would tear down the workspace for every later call.
			if (
				code === 255 &&
				!shuttingDown &&
				looksLikeTransportFailure(stderrText)
			) {
				reject(failTransport(stderrText));
				return;
			}
			resolve({
				exitCode: code,
				stdout: stdoutBuffer,
				stderr: stderrBuffer,
			});
		});
	});
}

async function runChecked(command, options = {}) {
	const result = await runSsh(command, options);
	if (result.exitCode !== 0) {
		const detail = result.stderr.toString("utf8").trim();
		throw new Error(
			detail || `Remote command exited with code ${result.exitCode}`,
		);
	}
	return result;
}

// --- Persistent SSH session (Windows / no ControlMaster) ---------------------
// A single ssh process runs a remote loop that reads base64-encoded commands on
// stdin, runs each with sh, and reports the exit code via an end marker on
// stderr. Commands are serialized; the session is torn down on error, abort, or
// timeout and re-established on the next call.
let session = null;
let sessionQueue = Promise.resolve();

function shellBase64Decode(value) {
	return `$(printf '%s' "${value}" | base64 -d 2>/dev/null || printf '%s' "${value}" | base64 -D 2>/dev/null)`;
}

function sessionLoopScript(nonce) {
	return [
		"while IFS= read -r __pilo_line; do",
		'  case "$__pilo_line" in',
		"    C*)",
		"      __pilo_cmd=" + shellBase64Decode("${__pilo_line#C}"),
		'      __pilo_in=""',
		"      ;;",
		'    I*) __pilo_in="$__pilo_in${__pilo_line#I}"',
		"      ;;",
		"    E)",
		'      if [ -n "$__pilo_in" ]; then',
		'        printf \'%s\' "$__pilo_in" | base64 -d 2>/dev/null | sh -c "$__pilo_cmd"',
		'      elif [ -n "$__pilo_cmd" ]; then',
		'        sh -c "$__pilo_cmd" < /dev/null',
		"      else",
		"        continue",
		"      fi",
		"      printf '\\036PILO" + nonce + '\\037%s\\036\' "$?"',
		'      __pilo_cmd=""',
		"      ;;",
		"  esac",
		"done",
	].join("\n");
}

function ensureSession() {
	if (session) return session;
	const nonce = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	const child = spawn("ssh", [...sshArgs(), sessionLoopScript(nonce)], {
		env: sshEnvironment(),
		windowsHide: true,
		stdio: ["pipe", "pipe", "pipe"],
	});
	const created = {
		child,
		marker: `\x1ePILO${nonce}\x1f`,
		pending: null,
	};
	session = created;

	child.stdout.on("data", (chunk) => {
		const pending = created.pending;
		if (!pending) return;
		consumeSessionStdout(created, pending, chunk);
	});
	child.stderr.on("data", (chunk) => {
		const pending = created.pending;
		if (!pending) return;
		pending.stderr += chunk.toString("utf8");
		if (pending.options.onData) pending.options.onData(chunk);
	});
	const onDeath = (error) => {
		if (session === created) session = null;
		const pending = created.pending;
		created.pending = null;
		if (pending && !pending.settled) {
			pending.settled = true;
			pending.cleanup();
			pending.reject(
				error
					? failTransport(error.message)
					: failTransport(pending.stderr || "SSH session closed"),
			);
		}
	};
	child.on("error", (error) => onDeath(error));
	child.on("close", () => onDeath());
	return created;
}

function consumeSessionStdout(created, pending, chunk) {
	const marker = Buffer.from(created.marker, "utf8");
	const combined = Buffer.concat([pending.stdoutTail, chunk]);
	const index = combined.indexOf(marker);
	if (index < 0) {
		// Hold back enough bytes to detect a completion marker split across chunks.
		const keep = marker.length + 16;
		const safeEnd = Math.max(0, combined.length - keep);
		if (safeEnd > 0)
			appendSessionStdout(pending, combined.subarray(0, safeEnd));
		pending.stdoutTail = combined.subarray(safeEnd);
		return;
	}

	const beforeMarker = combined.subarray(0, index);
	if (beforeMarker.length > 0) appendSessionStdout(pending, beforeMarker);
	const rest = combined.subarray(index + marker.length);
	const end = rest.indexOf(0x1e);
	if (end < 0) {
		pending.stdoutTail = combined.subarray(index);
		return;
	}
	const code = Number.parseInt(rest.subarray(0, end).toString("ascii"), 10);
	if (created.pending === pending) created.pending = null;
	if (pending.settled) return;
	pending.settled = true;
	pending.cleanup();
	if (Number.isNaN(code)) {
		destroySession(created);
		pending.reject(
			failTransport("SSH session returned an invalid completion marker"),
		);
		return;
	}
	pending.resolve({
		exitCode: code,
		stdout: Buffer.concat(pending.stdout),
		stderr: Buffer.from(pending.stderr, "utf8"),
	});
}

function appendSessionStdout(pending, chunk) {
	pending.stdout.push(chunk);
	if (pending.options.onData) pending.options.onData(chunk);
}

function destroySession(created) {
	if (session === created) session = null;
	try {
		created.child.kill();
	} catch {}
}

function runSession(command, options = {}) {
	const run = () => sessionCommand(command, options);
	const result = sessionQueue.then(run, run);
	sessionQueue = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

function sessionCommand(command, options) {
	const created = ensureSession();
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) {
			reject(new Error("Operation aborted"));
			return;
		}
		// Frame the command and any stdin payload as base64 lines so a large
		// payload never has to fit in the remote shell's argument list.
		const frames = [`C${Buffer.from(command, "utf8").toString("base64")}\n`];
		if (options.input !== undefined && options.input.length > 0) {
			const encoded = options.input.toString("base64");
			for (let offset = 0; offset < encoded.length; offset += 60000) {
				frames.push(`I${encoded.slice(offset, offset + 60000)}\n`);
			}
		}
		frames.push("E\n");
		const pending = {
			options,
			stdout: [],
			stdoutTail: Buffer.alloc(0),
			stderr: "",
			settled: false,
			cleanup: () => {},
			resolve,
			reject,
		};
		const fail = (error) => {
			if (pending.settled) return;
			pending.settled = true;
			if (created.pending === pending) created.pending = null;
			pending.cleanup();
			destroySession(created);
			reject(error);
		};
		const onAbort = () => fail(new Error("Operation aborted"));
		let timeoutHandle;
		pending.cleanup = () => {
			options.signal?.removeEventListener("abort", onAbort);
			if (timeoutHandle) clearTimeout(timeoutHandle);
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.timeoutSeconds) {
			timeoutHandle = setTimeout(
				() =>
					fail(
						new Error(`SSH command timed out after ${options.timeoutSeconds}s`),
					),
				options.timeoutSeconds * 1000,
			);
		}
		created.pending = pending;
		if (!created.child.stdin) {
			fail(failTransport("SSH session stdin unavailable"));
			return;
		}
		created.child.stdin.write(frames.join(""), (error) => {
			if (error && !pending.settled) {
				fail(failTransport(`SSH session write failed: ${error.message}`));
			}
		});
	});
}
function parseWorkspaceFrame(stdout) {
	const text = stdout.toString("utf8");
	const start = text.lastIndexOf(workspaceFrame);
	const end =
		start < 0 ? -1 : text.indexOf("\x1e", start + workspaceFrame.length);
	if (start < 0 || end < 0) {
		throw new Error(
			"Could not determine the remote HOME and working directory",
		);
	}
	const [home, cwd] = text
		.slice(start + workspaceFrame.length, end)
		.split("\x1f");
	if (!home?.startsWith("/") || !cwd?.startsWith("/")) {
		throw new Error("SSH returned an invalid remote HOME or working directory");
	}
	return { home, cwd };
}

async function connectWorkspace() {
	if (runtime.kind === "active") return;
	if (reconnectPromise) return reconnectPromise;
	runtime = { kind: "connecting" };
	reconnectPromise = (async () => {
		try {
			const probe = await runChecked(
				`cd -- ${shellQuote(config.remoteCwd)} && printf '\\036PILO_SSH_WORKSPACE\\037%s\\037%s\\036' "$HOME" "$(pwd -P)"`,
				{ allowConnecting: true, timeoutSeconds: 15 },
			);
			const workspace = parseWorkspaceFrame(probe.stdout);
			remoteHome = workspace.home;
			config.remoteCwd = workspace.cwd;
			runtime = { kind: "active" };
		} catch (error) {
			const detail = failureDetail(error);
			runtime = { kind: "failed", error: detail };
			throw new Error(`SSH workspace unavailable: ${detail}`, { cause: error });
		}
	})().finally(() => {
		reconnectPromise = undefined;
	});
	return reconnectPromise;
}

async function ensureActive() {
	if (runtime.kind === "active") return;
	await connectWorkspace();
}

function createRemoteReadOperations(signal, explicitRemotePath) {
	const remotePath = (filePath) => explicitRemotePath ?? toRemote(filePath);
	return {
		readFile: async (filePath) =>
			(
				await runChecked(`cat -- ${shellQuote(remotePath(filePath))}`, {
					signal,
				})
			).stdout,
		access: async (filePath) => {
			await runChecked(`test -r ${shellQuote(remotePath(filePath))}`, {
				signal,
			});
		},
		detectImageMimeType: async (filePath) => {
			const result = await runSsh(
				`command -v file >/dev/null 2>&1 && file --mime-type -b -- ${shellQuote(remotePath(filePath))}`,
				{ signal },
			);
			if (result.exitCode !== 0) return null;
			const mime = result.stdout.toString("utf8").trim().toLowerCase();
			return supportedImageTypes.has(mime) ? mime : null;
		},
	};
}

function createRemoteWriteOperations(signal, explicitRemotePath) {
	return {
		mkdir: async (dir) => {
			const remoteDir = explicitRemotePath
				? path.posix.dirname(explicitRemotePath)
				: toRemote(dir);
			await runChecked(`mkdir -p -- ${shellQuote(remoteDir)}`, { signal });
		},
		writeFile: async (filePath, content) => {
			await runChecked(
				`cat > ${shellQuote(explicitRemotePath ?? toRemote(filePath))}`,
				{
					signal,
					input: Buffer.from(content, "utf8"),
				},
			);
		},
	};
}

function createRemoteEditOperations(signal, explicitRemotePath) {
	const read = createRemoteReadOperations(signal, explicitRemotePath);
	const write = createRemoteWriteOperations(signal, explicitRemotePath);
	return {
		readFile: read.readFile,
		access: async (filePath) => {
			const remotePath = explicitRemotePath ?? toRemote(filePath);
			await runChecked(
				`test -r ${shellQuote(remotePath)} && test -w ${shellQuote(remotePath)}`,
				{ signal },
			);
		},
		writeFile: write.writeFile,
	};
}

function createRemoteBashOperations() {
	return {
		exec: async (command, cwd, options) => {
			await ensureActive();
			const remoteCwd = toRemote(cwd);
			const remoteCommand = `cd -- ${shellQuote(remoteCwd)} && ${remoteSessionExports(options.env)}exec bash -c ${shellQuote(command)}`;
			const result = await runSsh(remoteCommand, {
				signal: options.signal,
				timeoutSeconds: options.timeout,
				onData: options.onData,
			});
			return { exitCode: result.exitCode };
		},
	};
}

function textResult(text) {
	return { content: [{ type: "text", text }] };
}

async function formatRemoteOutput(buffer, signal, label) {
	if (buffer.length <= maxSearchBytes) {
		return { text: buffer.toString("utf8"), truncated: false };
	}
	const preview = buffer.toString("utf8").slice(0, maxSearchBytes);
	const fullPath = await spillRemoteOutput(buffer, signal, label);
	const notice = fullPath
		? `\n\n[Output truncated at ${maxSearchBytes / 1024}KB. Full output saved to ${fullPath}]`
		: `\n\n[Output truncated at ${maxSearchBytes / 1024}KB]`;
	return { text: preview + notice, truncated: true };
}

async function spillRemoteOutput(buffer, signal, label) {
	const script = `umask 077; f=$(mktemp "\${TMPDIR:-/tmp}/pilo-${label}-XXXXXX") || exit 1; cat > "$f" && printf '%s' "$f"`;
	try {
		const result = await runSsh(`exec sh -c ${shellQuote(script)}`, {
			signal,
			input: buffer,
		});
		if (result.exitCode !== 0) return null;
		return result.stdout.toString("utf8").trim() || null;
	} catch {
		return null;
	}
}

function createRemoteFindOperations(signal, remoteRoot) {
	return {
		exists: async () => {
			const result = await runSsh(`test -e ${shellQuote(remoteRoot)}`, {
				signal,
			});
			return result.exitCode === 0;
		},
		glob: async (pattern, _searchPath, options) => {
			const limit = Math.max(1, options.limit || 1000);
			const script = `
cd -- ${shellQuote(remoteRoot)} || exit 1
pattern=${shellQuote(pattern)}
limit=${limit}
count=0
emit() {
  rel="\${1#./}"
  printf '%s\\n' "$rel"
  count=$((count + 1))
  [ "$count" -ge "$limit" ]
}
if command -v rg >/dev/null 2>&1; then
  rg --files --hidden -g '!**/.git/**' -g '!**/node_modules/**' -g "$pattern" . |
  while IFS= read -r rel; do
    emit "$rel" && break
  done
else
  find . -mindepth 1 -print |
  while IFS= read -r candidate; do
    rel="\${candidate#./}"
    case "$rel" in .git|.git/*|node_modules|node_modules/*|*/.git/*|*/node_modules/*) continue ;; esac
    if [ "$pattern" != "\${pattern%/*}" ]; then target="$rel"; else target="\${rel##*/}"; fi
    case "$target" in $pattern) emit "$rel" && break ;; esac
  done
fi
exit 0
`;
			const result = await runChecked(`exec sh -c ${shellQuote(script)}`, {
				signal,
			});
			return result.stdout
				.toString("utf8")
				.split("\n")
				.map((line) => line.trim())
				.filter(Boolean);
		},
	};
}

function createRemoteLsOperations(signal, localRoot, remoteRoot) {
	const statCache = new Map();
	const mapPath = (absolutePath) => {
		const relative = path.relative(localRoot, absolutePath);
		return relative &&
			!relative.startsWith(`..${path.sep}`) &&
			relative !== ".."
			? path.posix.resolve(remoteRoot, relative.split(path.sep).join("/"))
			: remoteRoot;
	};
	const remember = (remotePath, isDirectory) => {
		const info = { isDirectory: () => isDirectory };
		statCache.set(remotePath, info);
		return info;
	};
	return {
		exists: async (absolutePath) => {
			const result = await runSsh(
				`test -e ${shellQuote(mapPath(absolutePath))}`,
				{
					signal,
				},
			);
			return result.exitCode === 0;
		},
		stat: async (absolutePath) => {
			// Reuse the directory flag discovered by readdir so Pi's per-entry
			// stat() does not add one SSH round trip per directory entry.
			const remotePath = mapPath(absolutePath);
			const cached = statCache.get(remotePath);
			if (cached) return cached;
			const isDir = await runSsh(`test -d ${shellQuote(remotePath)}`, {
				signal,
			});
			if (isDir.exitCode !== 0) {
				const exists = await runSsh(`test -e ${shellQuote(remotePath)}`, {
					signal,
				});
				if (exists.exitCode !== 0) {
					throw new Error(`Path not found: ${absolutePath}`);
				}
			}
			return remember(remotePath, isDir.exitCode === 0);
		},
		readdir: async (absolutePath) => {
			const remotePath = mapPath(absolutePath);
			remember(remotePath, true);
			const result = await runSsh(`ls -Ap -- ${shellQuote(remotePath)}`, {
				signal,
			});
			if (result.exitCode !== 0) {
				throw new Error(
					result.stderr.toString("utf8").trim() || "Cannot read directory",
				);
			}
			return result.stdout
				.toString("utf8")
				.split("\n")
				.filter((line) => line.length > 0)
				.map((entry) => {
					const isDirectory = entry.endsWith("/");
					const name = isDirectory ? entry.slice(0, -1) : entry;
					remember(path.posix.join(remotePath, name), isDirectory);
					return name;
				});
		},
	};
}

async function remoteGrep(params, signal, ctx) {
	await ensureActive();
	const root = resolveRemoteInput(params.path || ".", ctx?.cwd || localCwd);
	const limit = Math.max(1, params.limit ?? 100);
	const context = Math.max(0, params.context ?? 0);
	const outputLines = Math.max(limit, limit * (context * 2 + 2));
	const rgArgs = [
		"--line-number",
		"--color=never",
		"--hidden",
		"--glob",
		"!**/.git/**",
		"--glob",
		"!**/node_modules/**",
		...(params.ignoreCase ? ["--ignore-case"] : []),
		...(params.literal ? ["--fixed-strings"] : []),
		...(params.glob ? ["--glob", params.glob] : []),
		...(context ? ["--context", String(context)] : []),
		"--",
		params.pattern,
	]
		.map(shellQuote)
		.join(" ");
	const grepFlags = [
		"-R",
		"-I",
		"-n",
		...(params.ignoreCase ? ["-i"] : []),
		...(params.literal ? ["-F"] : []),
		...(context ? [`-C${context}`] : []),
	].join(" ");
	const script = `
root=${shellQuote(root)}
if [ -d "$root" ]; then
  cd -- "$root" || exit 1
  target=.
elif [ -f "$root" ]; then
  cd -- "$(dirname -- "$root")" || exit 1
  target="./$(basename -- "$root")"
else
  printf 'Path not found: %s\\n' "$root" >&2
  exit 1
fi
if command -v rg >/dev/null 2>&1; then
  (rg ${rgArgs} "$target"; status=$?; [ "$status" -eq 0 ] || [ "$status" -eq 1 ] || exit "$status") |
    awk 'NR <= ${outputLines} { print } NR > ${outputLines} { exit }'
else
  (grep ${grepFlags} -- ${shellQuote(params.pattern)} "$target"; status=$?; [ "$status" -eq 0 ] || [ "$status" -eq 1 ] || exit "$status") |
    awk 'NR <= ${outputLines} { print } NR > ${outputLines} { exit }'
fi
exit 0
`;
	const result = await runChecked(`exec sh -c ${shellQuote(script)}`, {
		signal,
	});
	const output = await formatRemoteOutput(result.stdout, signal, "grep");
	const text = output.text.trim();
	return textResult(text || "No matches found");
}

export default function piloSshWorkspace(pi) {
	const readTemplate = createReadToolDefinition(localCwd);
	const writeTemplate = createWriteToolDefinition(localCwd);
	const editTemplate = createEditToolDefinition(localCwd);
	const bashTemplate = createBashToolDefinition(localCwd);
	const grepTemplate = createGrepToolDefinition(localCwd);
	const findTemplate = createFindToolDefinition(localCwd);
	const lsTemplate = createLsToolDefinition(localCwd);

	pi.registerTool({
		...readTemplate,
		async execute(id, params, signal, onUpdate, ctx) {
			await ensureActive();
			const cwd = ctx?.cwd || localCwd;
			const remotePath = resolveRemoteInput(params.path, cwd);
			return createReadToolDefinition(cwd, {
				operations: createRemoteReadOperations(signal, remotePath),
			}).execute(id, params, signal, onUpdate, ctx);
		},
	});
	pi.registerTool({
		...writeTemplate,
		async execute(id, params, signal, onUpdate, ctx) {
			await ensureActive();
			const cwd = ctx?.cwd || localCwd;
			const remotePath = resolveRemoteInput(params.path, cwd);
			return createWriteToolDefinition(cwd, {
				operations: createRemoteWriteOperations(signal, remotePath),
			}).execute(id, params, signal, onUpdate, ctx);
		},
	});
	pi.registerTool({
		...editTemplate,
		async execute(id, params, signal, onUpdate, ctx) {
			await ensureActive();
			const cwd = ctx?.cwd || localCwd;
			const remotePath = resolveRemoteInput(params.path, cwd);
			return createEditToolDefinition(cwd, {
				operations: createRemoteEditOperations(signal, remotePath),
			}).execute(id, params, signal, onUpdate, ctx);
		},
	});
	pi.registerTool({
		...bashTemplate,
		async execute(id, params, signal, onUpdate, ctx) {
			await ensureActive();
			return createBashToolDefinition(ctx?.cwd || localCwd, {
				operations: createRemoteBashOperations(),
			}).execute(id, params, signal, onUpdate, ctx);
		},
	});
	pi.registerTool({
		...grepTemplate,
		execute(_id, params, signal, _onUpdate, ctx) {
			return remoteGrep(params, signal, ctx);
		},
	});
	pi.registerTool({
		...findTemplate,
		async execute(id, params, signal, onUpdate, ctx) {
			await ensureActive();
			const cwd = ctx?.cwd || localCwd;
			const remoteRoot = resolveRemoteInput(params.path || ".", cwd);
			return createFindToolDefinition(cwd, {
				operations: createRemoteFindOperations(signal, remoteRoot),
			}).execute(id, params, signal, onUpdate, ctx);
		},
	});
	pi.registerTool({
		...lsTemplate,
		async execute(id, params, signal, onUpdate, ctx) {
			await ensureActive();
			const cwd = ctx?.cwd || localCwd;
			const inputPath = params.path || ".";
			const localRoot = path.resolve(cwd, inputPath);
			const remoteRoot = resolveRemoteInput(inputPath, cwd);
			return createLsToolDefinition(cwd, {
				operations: createRemoteLsOperations(signal, localRoot, remoteRoot),
			}).execute(id, params, signal, onUpdate, ctx);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		try {
			await connectWorkspace();
			ctx.ui?.setStatus?.("pilo-ssh-workspace", `SSH · ${config.label}`);
		} catch (error) {
			ctx.ui?.notify?.(
				`SSH workspace unavailable: ${failureDetail(error)}`,
				"error",
			);
		}
	});

	pi.on("user_bash", () => ({
		operations: createRemoteBashOperations(),
	}));

	pi.on("before_agent_start", async (event) => {
		if (runtime.kind !== "active") return;
		const localMarker = `Current working directory: ${localCwd}`;
		const remoteMarker = `Current working directory: ${config.remoteCwd} (SSH workspace: ${config.label})`;
		let systemPrompt = event.systemPrompt.includes(localMarker)
			? event.systemPrompt.replace(localMarker, remoteMarker)
			: `${event.systemPrompt
					.split("\n")
					.filter((line) => !line.includes(localCwd))
					.join("\n")}\n\n${remoteMarker}`;
		return { systemPrompt };
	});

	pi.on("context", (event) => {
		const messages = event.messages.filter(
			(message) =>
				!(
					message.role === "custom" &&
					message.customType === "pilo-ssh-workspace"
				),
		);
		const content =
			runtime.kind === "active"
				? `Pilo SSH workspace (authoritative): ${config.label}:${config.remoteCwd}. read, write, edit, bash, grep, find, ls, and user ! commands operate on this remote workspace. The local Pi cwd (${localCwd}) is only a session anchor.`
				: runtime.kind === "failed"
					? `Pilo SSH workspace is unavailable: ${runtime.error}. Workspace tools fail closed and must not fall back to the local filesystem.`
					: `Pilo SSH workspace is still connecting to ${config.label}. Workspace tools must not run locally.`;
		return {
			messages: [
				...messages,
				{
					role: "custom",
					customType: "pilo-ssh-workspace",
					content,
					display: false,
					details: { runtime: runtime.kind, remoteCwd: config.remoteCwd },
					timestamp: Date.now(),
				},
			],
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		shuttingDown = true;
		ctx.ui?.setStatus?.("pilo-ssh-workspace", undefined);
		if (session) destroySession(session);
		if (muxPath) {
			try {
				const args = [...config.sshArgs];
				const destination = args.pop();
				await new Promise((resolve) => {
					const child = spawn(
						"ssh",
						[...args, "-S", muxPath, "-O", "exit", destination],
						{
							env: sshEnvironment(),
							stdio: "ignore",
							windowsHide: true,
						},
					);
					child.on("error", () => resolve());
					child.on("close", () => resolve());
				});
			} catch {}
			try {
				rmSync(muxDir, { recursive: true, force: true });
			} catch {}
		}
	});
}
