// What `nsh check` sees for `@/lib/chat/conversation-runtime-adapter` (see
// `tsconfig.json` `paths`); the bundle still loads the real module. Its
// real parameter type, `PiloRuntimeEvent`, reaches the web client's DOM and
// Tauri modules through `src/lib/api/pi-runtime-types.ts`; this stand-in
// goes once those protocol types are split from the web client (M1).
import type { ConversationAction } from "../../src/lib/chat/conversation-types.ts";

/** A runtime event of the Pilo host, as the event bus serializes it. */
export interface RuntimeEventLike {
	readonly type: string;
	readonly [field: string]: unknown;
}

export declare function toConversationAction(
	event: RuntimeEventLike,
): ConversationAction | null;
