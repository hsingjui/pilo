import type { CacheKeepAliveStatus } from "@shared/cache-keep-alive";

import type { PiSessionSnapshot } from "./pi-runtime-types";

export type ChatSessionRuntimeState = {
	sessionKey: string;
	projectId: string;
	sessionPath?: string | null;
	prepared: boolean;
	initialized: boolean;
	activeTurn: boolean;
	compacting?: boolean;
	cacheKeepAlive?: CacheKeepAliveStatus | null;
	snapshot: PiSessionSnapshot;
};
