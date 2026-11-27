import { mount, setTheme, signal, Text, View } from "nsh";

import type { ConversationEvent } from "@shared/chat/conversation-types";
import type { Connection } from "@shared/api/pi-runtime-types";
import type { Project } from "@shared/api/projects-types";
import type { SessionIndexEntry } from "@shared/api/sessions-types";
import type { ThemeSettings } from "@shared/theme-settings-types";
import { AppShell } from "../shell/AppShell";
import { conversationContext, followOpenSession } from "../shell/open-chat";
import { initializeI18n } from "../shell/i18n";
import { AppStore } from "../state/app-store";
import { ComposerStore } from "../composer/composer-store";
import { ChatTranscriptStore } from "../state/chat-transcript-store";
import { Button } from "../ui/button";
import { setStyleTheme } from "../ui/theme-style";
import claude from "../../theme/claude-theme.json";
import { composerStubClient } from "./composer-fixture";
import { fixtureThemeFamily } from "./fixture-theme";
import { scriptedClient } from "./scripted-app-client";

/**
 * The shell over a scripted client with two projects and saved sessions, for
 * the command palette: `pilo` has three sessions, `api` has the latest one,
 * and message searches answer for the query "resize". The `lody`/`claude`
 * buttons swap the theme for screenshots.
 */
const local = { id: "local", name: "Local", kind: { type: "local" } };
const remote = { id: "c-build", name: "build-box", kind: { type: "ssh" } };
const piloProjectId = "project:local:/code/pilo";

function project(name: string, connection: object, id = name): Project {
	return {
		id,
		name,
		path: `/code/${name}`,
		connection: connection as Connection,
	} as Project;
}

/** A session of `projectId` whose last message came `day` days into November. */
function session(
	projectId: string,
	day: number,
	title: string | null,
): SessionIndexEntry {
	const at = `2026-11-${String(day).padStart(2, "0")}T09:00:00Z`;
	return {
		connectionId: projectId === "api" ? remote.id : local.id,
		projectId: projectId === "pilo" ? piloProjectId : projectId,
		piSessionId: `s${day}`,
		sessionPath: `/${projectId}/s${day}.jsonl`,
		name: null,
		cwd: `/code/${projectId}`,
		createdAt: at,
		updatedAt: at,
		messageCount: 2,
		lastMessageAt: at,
		firstUserMessagePreview: title,
		fileSize: 1,
		fileMtimeNs: "0",
		lastOffset: 1,
		indexedAtMs: 0,
		pinned: false,
		titleOverride: null,
	};
}

const sessions: Record<string, SessionIndexEntry[]> = {
	[piloProjectId]: [
		session("pilo", 1, "Port the settings page"),
		{
			...session("pilo", 2, "Fix the flaky dialog test"),
			name: "Dialog test",
			archivedAt: Date.UTC(2026, 10, 4),
		},
		session("pilo", 3, "Resize the sidebar"),
	],
	api: [session("api", 4, "Deploy the build box")],
};

/** A settled turn: a prompt and its reply. */
function turn(prompt: string, reply: string) {
	const timestampMs = Date.UTC(2026, 10, 4, 9, 0);
	return [
		{ type: "user_message_start", text: prompt, timestampMs },
		{ type: "assistant_message_start", timestampMs },
		{ type: "assistant_text_delta", delta: reply, timestampMs },
		{ type: "assistant_turn_end", stopReason: "stop", timestampMs },
	] as ConversationEvent[];
}

const searches = signal<string[]>([]);
const theme = signal("lody");

async function run() {
	const themeSettings = {
		revision: 1,
		theme: "system",
		themeFamily: await fixtureThemeFamily(),
	} as ThemeSettings;
	const runtime = scriptedClient({
		projects: [project("api", remote), project("pilo", local, piloProjectId)],
		themeSettings,
		sessions: (projectId) => Promise.resolve(sessions[projectId] ?? []),
		history: (sessionPath) => {
			if (sessionPath === "/pilo/s3.jsonl") {
				return Promise.resolve(
					turn("Resize the sidebar", "The sidebar now takes a width."),
				);
			}
			if (sessionPath === "/pilo/s2.jsonl") {
				return Promise.resolve(
					turn("Fix the flaky dialog test", "The dialog test is fixed."),
				);
			}
			return Promise.resolve([]);
		},
		onSearchSessions: (projectId, query) => {
			const name = projectId === piloProjectId ? "pilo" : projectId;
			searches.update((list) => [...list, `${name}:${query}`]);
			if (projectId !== piloProjectId || query !== "resize") return [];
			return [
				{
					sessionPath: "/pilo/s3.jsonl",
					sessionId: "s3",
					role: "assistant" as const,
					snippet: "The sidebar now takes a width.",
					timestamp: null,
				},
			];
		},
	});
	const chat = new ChatTranscriptStore(runtime.client, conversationContext());
	const store = new AppStore(runtime.client, chat);
	const composer = new ComposerStore({
		client: composerStubClient(runtime.client),
		app: store.state,
	});
	followOpenSession(store, chat);
	mount(() => (
		<View class="flex-1 bg-background">
			<AppShell
				store={store}
				chat={chat}
				composer={composer}
				searchSessions={runtime.client}
			/>
			<View class="absolute bottom-2 right-2 flex-row items-center gap-2">
				<Button
					testID="claude"
					onPress={() => {
						theme.set("claude");
						setTheme({ cssVars: claude.cssVars });
						setStyleTheme(claude.styleVars);
					}}
				>
					<Text>Claude theme</Text>
				</Button>
				<Text testID="searches">{() => searches().join(",")}</Text>
			</View>
		</View>
	));
	await store.start();
}

initializeI18n();
void run();
