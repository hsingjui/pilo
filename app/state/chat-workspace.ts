import type { HostClient } from "@shared/api/host-client";
import { ComposerStore } from "../composer/composer-store";
import type { ComposerQueue } from "../composer/composer-store";
import type { ComposerDraftTextStorage } from "../composer/composer-drafts";
import { AppToasts } from "../shell/app-toasts";
import type { DesktopShell } from "../shell/desktop-shell";
import { t } from "../shell/i18n";
import { createSessionAutoTitle } from "../shell/session-auto-title";
import type { AppStore } from "./app-store";
import type { ChatRunConfigStore } from "./chat-run-config";
import type { ChatTranscriptStore } from "./chat-transcript-store";
import type { ModelCatalogStore } from "./model-catalog";

/**
 * The composer a chat workspace shows, wired the same way on desktop and
 * Remote WebUI: drafts and toasts go through the app store, prompts start a
 * turn and ask for an automatic title, `/new` returns to the project, and
 * `/compact` refreshes the run config.
 */
export function createWorkspaceComposer(deps: {
	client: HostClient;
	hostId: string;
	shell?: Pick<DesktopShell, "readLocalFile">;
	store: AppStore;
	chat: ChatTranscriptStore;
	catalog: ModelCatalogStore;
	runConfig: ChatRunConfigStore;
	queue?: ComposerQueue;
	toasts: AppToasts;
	draftTextStorage?: ComposerDraftTextStorage;
	waitForStartupApproval?: (sessionKey: string) => Promise<boolean>;
	/** Extra per-shell new-chat handling; the active project is selected after it. */
	onNewChat?: (projectId: string | null | undefined) => void;
}): ComposerStore {
	const { client, store, chat, catalog, runConfig } = deps;
	const nameSession = createSessionAutoTitle(client, (target, error) => {
		composer.setStatus(
			`${t("settings.automaticNamingFailed")}: ${
				error instanceof Error ? error.message : String(error)
			}`,
			target.sessionKey,
		);
	});
	const composer = new ComposerStore({
		client,
		shell: deps.shell,
		hostId: deps.hostId,
		app: store.state,
		draftTextStorage: deps.draftTextStorage,
		queue: deps.queue,
		waitForStartupApproval: deps.waitForStartupApproval,
		catalog,
		activeModel: () => runConfig.state()?.model ?? null,
		beforeSend: (sessionKey, ensureReady, inBackground) =>
			runConfig.prepareToSend(sessionKey, ensureReady, inBackground),
		transcript: chat,
		onPendingDraft: (target, text) => store.setPendingDraft(target, text),
		onUnsentDraft: (target, text) => store.setUnsentDraft(target, text),
		onPromptStarted: (target, text) => {
			store.confirmDraft(target, text);
			nameSession(target, text);
		},
		onNewChat: () => {
			const projectId =
				composer.target()?.projectId ?? store.state().navigation.projectId;
			deps.onNewChat?.(projectId);
			if (projectId) store.selectProject(projectId);
		},
		onCompacted: () => {
			void runConfig.refresh();
		},
		onNotice: (notice) => deps.toasts.show(notice),
	});
	return composer;
}
