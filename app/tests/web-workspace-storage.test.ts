import { expect, test } from "nsh/test";

import { chatSessionKey } from "@shared/api/chat-session-key";
import type { ComposerTarget } from "../composer/composer-store";
import { browserGlobal } from "../../web/web-remote-browser";
import {
	REMOTE_SEQUENCE_KEY,
	WebRemotePiloClient,
} from "../../web/web-remote-client";
import { createWebWorkspaceStorage } from "../../web/web-workspace-storage";

function tabStorage(initial: Record<string, string> = {}) {
	const values = new Map(Object.entries(initial));
	return {
		get length() {
			return values.size;
		},
		key: (index: number) => [...values.keys()][index] ?? null,
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => void values.set(key, value),
		removeItem: (key: string) => void values.delete(key),
	};
}

test("remote client loads and flushes the event cursor for its Host", () => {
	const global = browserGlobal();
	const original = Object.getOwnPropertyDescriptor(global, "localStorage");
	const storage = tabStorage({
		[REMOTE_SEQUENCE_KEY]: "42",
		[`${REMOTE_SEQUENCE_KEY}@other`]: "81",
	});
	Object.defineProperty(global, "localStorage", {
		configurable: true,
		value: storage,
	});
	try {
		new WebRemotePiloClient("test-token", {
			origin: "http://localhost",
			hostId: "other",
		}).dispose();
		expect(storage.getItem(REMOTE_SEQUENCE_KEY)).toBe("42");
		expect(storage.getItem(`${REMOTE_SEQUENCE_KEY}@other`)).toBe("81");
		new WebRemotePiloClient("test-token", {
			origin: "http://localhost",
		}).dispose();
		expect(storage.getItem(REMOTE_SEQUENCE_KEY)).toBe(null);
		expect(storage.getItem(`${REMOTE_SEQUENCE_KEY}@local`)).toBe("42");
	} finally {
		if (original) Object.defineProperty(global, "localStorage", original);
		else delete global.localStorage;
	}
});

test("Web workspace restores old active project, draft rows and saved-session text on upgrade", () => {
	const projectId = "repo:with:colons";
	const draftKey = chatSessionKey(projectId, "draft-session-1");
	const savedKey = chatSessionKey(projectId, "/session.jsonl");
	const saved = {
		projectId,
		sessionKey: savedKey,
		sessionPath: "/session.jsonl",
	};
	const olderSaved = {
		...saved,
		sessionPath: "/older.jsonl",
		sessionKey: chatSessionKey(projectId, "/older.jsonl"),
	};
	const storage = tabStorage({
		"pilo.web.activeProject.v1": projectId,
		[`pilo.web.draftText.v3:${draftKey}`]: "modern draft",
		[`pilo.web.draftText.v1:${projectId}`]: "old project draft",
		"pilo.web.draftText.v2:draft:second": "older draft",
		[`pilo.web.savedDraftText.v1:${savedKey}`]: "saved draft",
		[`pilo.web.draftText.v2:${olderSaved.sessionKey}`]: "older saved draft",
		[`pilo.web.draftText.v3@other:${draftKey}`]: "other Host draft",
	});
	const workspace = createWebWorkspaceStorage(storage);
	const restored: [ComposerTarget, string][] = [];
	workspace.restoreDrafts((target, text) => restored.push([target, text]));
	expect(restored.map(([, text]) => text)).toEqual([
		"modern draft",
		"old project draft",
		"older draft",
	]);
	expect(restored[0][0]).toEqual({ projectId, sessionKey: draftKey });
	expect(workspace.readActiveProject()).toBe(projectId);
	expect(workspace.draftText.read(saved)).toBe("saved draft");
	expect(workspace.draftText.read(olderSaved)).toBe("older saved draft");
	expect(
		[...Array(storage.length).keys()]
			.map(storage.key)
			.every((key) => key?.includes("@")),
	).toBe(true);

	const reopened = createWebWorkspaceStorage(storage);
	const again: [ComposerTarget, string][] = [];
	reopened.restoreDrafts((target, text) => again.push([target, text]));
	expect(again).toEqual(restored);
	expect(reopened.readActiveProject()).toBe(projectId);
	expect(reopened.draftText.read(saved)).toBe("saved draft");
	expect(reopened.draftText.read(olderSaved)).toBe("older saved draft");
});

test("Web drafts prefer the namespaced copy, do not cross Hosts and do not revive on clear", () => {
	const target = {
		projectId: "p1",
		sessionKey: chatSessionKey("p1", "draft-session-1"),
	};
	const oldKey = `pilo.web.draftText.v3:${target.sessionKey}`;
	const storage = tabStorage({
		[oldKey]: "old",
		[`pilo.web.draftText.v3@local:${target.sessionKey}`]: "new",
		"pilo.web.activeProject.v1": "p1",
	});
	const remote = createWebWorkspaceStorage(storage, "other");
	expect(remote.readActiveProject()).toBe(null);
	expect(remote.draftText.read(target)).toBe(null);
	const local = createWebWorkspaceStorage(storage);
	const drafts: string[] = [];
	local.restoreDrafts((_, text) => drafts.push(text));
	expect(drafts).toEqual(["new"]);
	expect(local.draftText.write(target, "")).toBe(true);
	expect(local.draftText.read(target)).toBe(null);
	expect(storage.getItem(oldKey)).toBe(null);
	expect(
		local.draftText.read({
			...target,
			sessionKey: chatSessionKey("p1", "temporary-session-1"),
		}),
	).toBe(null);
});
