import type { PiAgentState } from "@shared/api/pi-runtime-types";
import {
	type PiCommandClient,
	requestPiRpc,
	requestPiRpcReply,
} from "../client/chat-rpc";
import type { DesktopHostClient } from "../client/host-api";
import type { ComposerTarget } from "../composer/composer-store";
import { isTemporarySessionKey } from "../state/app-state";

export type SessionAutoTitleClient = PiCommandClient &
	Pick<DesktopHostClient, "generateSessionTitle">;

/**
 * How long Pi may take to answer while it streams the turn, as the run
 * config waits; a slow SSH link should not count as a failed naming.
 */
const RPC_TIMEOUT_MS = 10_000;

/**
 * Names a new chat after the first prompt that started a turn in it, as the
 * WebUI app does: the connection's naming model titles the prompt, and Pi
 * takes the title as the session name unless it already has one. A saved
 * session or a temporary chat is not renamed, and each chat is titled at
 * most once.
 * `onFailed` hears why naming failed; a title that is turned off is not one.
 */
export function createSessionAutoTitle(
	client: SessionAutoTitleClient,
	onFailed: (target: ComposerTarget, error: unknown) => void,
) {
	const requested = new Set<string>();
	return (target: ComposerTarget, text: string) => {
		const prompt = text.trim();
		if (
			target.sessionPath ||
			!prompt ||
			requested.has(target.sessionKey) ||
			isTemporarySessionKey(target.sessionKey)
		) {
			return;
		}
		requested.add(target.sessionKey);
		void client
			.generateSessionTitle(target.projectId, prompt)
			.then(async (title) => {
				if (!title) return;
				const state = await requestPiRpc<PiAgentState>(
					client,
					target.sessionKey,
					{ type: "get_state" },
					RPC_TIMEOUT_MS,
				);
				if (!state) throw new Error("Pi did not return its session state");
				if (state.sessionName?.trim()) return;
				const reply = await requestPiRpcReply(
					client,
					target.sessionKey,
					{ type: "set_session_name", name: title },
					RPC_TIMEOUT_MS,
				);
				if (!reply) throw new Error("Pi did not confirm the session name");
			})
			.catch((error: unknown) => onFailed(target, error));
	};
}
