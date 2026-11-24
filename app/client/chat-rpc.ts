import type { NshPiloClient } from "./nsh-pilo-client";

export type PiCommandClient = Pick<
	NshPiloClient,
	"sendChatCommand" | "connectEvents"
> & {
	/** Namespaces RPCs on transports that broadcast replies to other clients. */
	readonly rpcIdPrefix?: string;
};

export const PI_RPC_TIMEOUT_MS = 5000;

let rpcSequence = 0;

/** An `rpc_message` response, as Pi replies it. */
export type PiRpcReply<T> = {
	data?: T;
	success?: boolean;
	error?: string;
};

type PiRpcOutcome<T> =
	| { type: "reply"; reply: PiRpcReply<T> }
	| { type: "not_sent" }
	| { type: "unconfirmed"; dispatchError?: Error };

/** Sends a Pi RPC, distinguishing a missing reply from a command never dispatched. */
export function requestPiRpcOutcome<T>(
	client: PiCommandClient,
	sessionKey: string,
	command: Record<string, unknown>,
	timeoutMs = PI_RPC_TIMEOUT_MS,
	canDispatch?: () => boolean,
): Promise<PiRpcOutcome<T>> {
	const id = `${client.rpcIdPrefix ?? "nsh-rpc"}-${++rpcSequence}`;
	return new Promise<PiRpcOutcome<T>>((resolve, reject) => {
		let settled = false;
		let connected = false;
		let dispatched = false;
		let disconnect: (() => void) | null = null;
		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			disconnect?.();
			disconnect = null;
		};
		const noReply = () => {
			finish();
			resolve({ type: dispatched ? "unconfirmed" : "not_sent" });
		};
		const timer = setTimeout(noReply, timeoutMs);
		const fail = (error: unknown) => {
			if (settled) return;
			finish();
			const cause = error instanceof Error ? error : new Error(String(error));
			// The Host can lose its Server connection after the write to Pi.
			if (dispatched) resolve({ type: "unconfirmed", dispatchError: cause });
			else reject(cause);
		};
		const dispatch = async () => {
			// Registration provides a disposer, not confirmation the stream is live.
			if (settled || dispatched || !disconnect || !connected) return;
			if (canDispatch && !canDispatch()) {
				noReply();
				return;
			}
			dispatched = true;
			await client.sendChatCommand(sessionKey, { ...command, id });
		};
		client
			.connectEvents({
				onMessage: (message) => {
					if (settled || message.type !== "events") return;
					for (const event of message.events) {
						if (event.type !== "rpc_message" || event.sessionKey !== sessionKey)
							continue;
						const reply = event.message;
						if (
							typeof reply !== "object" ||
							reply === null ||
							(reply as Record<string, unknown>).type !== "response" ||
							(reply as Record<string, unknown>).id !== id
						)
							continue;
						const data = reply as PiRpcReply<T>;
						finish();
						if (data.success === false)
							reject(new Error(data.error ?? "Pi command failed"));
						else resolve({ type: "reply", reply: data });
						return;
					}
				},
				onStatus: (ready) => {
					if (settled) return;
					connected = ready;
					if (ready) void dispatch().catch(fail);
					else noReply();
				},
			})
			.then((disposer) => {
				if (settled) {
					disposer();
					return;
				}
				disconnect = disposer;
				return dispatch();
			})
			.catch(fail);
	});
}

/** Resolves the correlated Pi reply (even without `data`), or `null` if missing. */
export async function requestPiRpcReply<T>(
	client: PiCommandClient,
	sessionKey: string,
	command: Record<string, unknown>,
	timeoutMs = PI_RPC_TIMEOUT_MS,
	canDispatch?: () => boolean,
): Promise<PiRpcReply<T> | null> {
	const outcome = await requestPiRpcOutcome<T>(
		client,
		sessionKey,
		command,
		timeoutMs,
		canDispatch,
	);
	if (outcome.type === "unconfirmed" && outcome.dispatchError) {
		throw outcome.dispatchError;
	}
	return outcome.type === "reply" ? outcome.reply : null;
}

/**
 * {@link requestPiRpcReply} for callers that only want the reply's `data`:
 * `null` when the reply never came or it carried none.
 */
export function requestPiRpc<T>(
	client: PiCommandClient,
	sessionKey: string,
	command: Record<string, unknown>,
	timeoutMs = PI_RPC_TIMEOUT_MS,
): Promise<T | null> {
	return requestPiRpcReply<T>(client, sessionKey, command, timeoutMs).then(
		(reply) => reply?.data ?? null,
	);
}
