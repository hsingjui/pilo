import { type Accessor, cleanup, signal, Text, token, View } from "nsh";

import { userErrorMessage } from "@shared/app-error";
import type { PiloClientEvent } from "@shared/api/pilo-client";
import { webInputFontSize } from "@shared/web-font-scale";
import type {
	ComposerStore,
	ComposerTarget,
} from "../app/composer/composer-store";
import type { AppToasts } from "../app/shell/app-toasts";
import { t } from "../app/shell/i18n";
import { Button } from "../app/ui/button";
import { Dialog } from "../app/ui/dialog";
import { DialogDescription } from "../app/ui/dialog-description";
import { DialogTitle } from "../app/ui/dialog-title";
import { Input } from "../app/ui/input";
import { Textarea } from "../app/ui/textarea";
import { MobileViewport } from "./mobile-viewport";
import type { WebRemotePiloClient } from "./web-remote-client";

type Request = Extract<PiloClientEvent, { type: "extension_ui_request" }>;
type Response =
	| { value: string }
	| { confirmed: boolean }
	| { cancelled: true };
type Approval = {
	server: string;
	result: Promise<boolean>;
	finish: (approved: boolean) => void;
};

type PendingDialog = {
	id: string;
	target: ComposerTarget;
	request: Request;
	approval?: Approval;
	expiresAtMs?: number;
	timer?: ReturnType<typeof setTimeout>;
};

function projectMcpServer(request: Request): string | undefined {
	if (
		request.method !== "confirm" ||
		!request.message?.startsWith("Project config:")
	)
		return undefined;
	return (
		request.title
			?.match(/^Allow project MCP server [“"](.+?)[”"]\?$/)?.[1]
			?.trim() || undefined
	);
}

export class RemoteExtensionUi {
	private readonly pending = signal<readonly PendingDialog[]>([]);
	private readonly responding = signal<string | null>(null);
	private readonly approvals = new Map<string, PendingDialog>();
	private disposed = false;

	constructor(
		private readonly client: Pick<
			WebRemotePiloClient,
			"sendChatCommand" | "approveProjectMcpServer"
		>,
		private readonly toasts: AppToasts,
	) {}

	dialog(sessionKey: string | undefined) {
		const responding = this.responding();
		return this.pending()
			.filter(
				(dialog) =>
					dialog.target.sessionKey === sessionKey &&
					(responding === null || responding === dialog.id),
			)
			.slice(0, 1);
	}

	backgroundDialog(activeSessionKey: string | undefined): PendingDialog | null {
		return (
			this.pending().find(
				(dialog) => dialog.target.sessionKey !== activeSessionKey,
			) ?? null
		);
	}

	busy(id: string) {
		return this.responding() === id;
	}

	receive(event: PiloClientEvent, composer: ComposerStore) {
		if (this.disposed || !event.sessionKey) return;
		if (event.type === "process_state") {
			for (const dialog of this.pending()) {
				if (dialog.target.sessionKey !== event.sessionKey || dialog.approval)
					continue;
				if (
					dialog.request.generation < event.generation ||
					(dialog.request.generation === event.generation &&
						(event.state === "stopped" || event.state === "failed"))
				) {
					this.remove(dialog);
				}
			}
			return;
		}
		if (event.type !== "extension_ui_request") return;
		const active = composer.target();
		if (event.method === "set_editor_text") {
			if (active?.sessionKey === event.sessionKey && event.text !== null)
				composer.setValue(event.text);
			return;
		}
		if (!["select", "confirm", "input", "editor"].includes(event.method))
			return;
		// Keep background prompts for their own chat, never answer through the active chat.
		const projectId =
			event.projectId ??
			(active?.sessionKey === event.sessionKey ? active.projectId : undefined);
		if (!projectId) return;
		const id = JSON.stringify([event.sessionKey, event.generation, event.id]);
		if (this.pending().some((dialog) => dialog.id === id)) return;

		const server = projectMcpServer(event);
		const existing = this.approvals.get(event.sessionKey);
		if (
			server &&
			existing?.approval?.server === server &&
			(existing.request.id === event.id || this.pending().includes(existing))
		)
			return;
		let approval: Approval | undefined;
		if (server) {
			let finish!: Approval["finish"];
			const result = new Promise<boolean>((resolve) => {
				finish = resolve;
			});
			approval = { server, result, finish };
		}
		const dialog: PendingDialog = {
			id,
			target: { sessionKey: event.sessionKey, projectId },
			request: event,
			approval,
			expiresAtMs:
				event.timeout !== null && event.timeout > 0
					? Date.now() + event.timeout
					: undefined,
		};
		if (approval) this.approvals.set(event.sessionKey, dialog);
		if (event.timeout !== null && event.timeout > 0) {
			dialog.timer = setTimeout(() => {
				if (!this.busy(id)) {
					approval?.finish(false);
					this.remove(dialog);
				}
			}, event.timeout);
		}
		this.pending.update((pending) => [...pending, dialog]);
	}

	/** A project approval can outlive the Pi process that requested it. */
	async waitForStartupApproval(sessionKey: string) {
		const dialog = this.approvals.get(sessionKey);
		if (!dialog?.approval) return false;
		const approved = await dialog.approval.result;
		if (this.approvals.get(sessionKey) === dialog)
			this.approvals.delete(sessionKey);
		return approved && !this.disposed;
	}

	async respond(dialog: PendingDialog, response: Response) {
		if (this.responding() !== null || !this.pending().includes(dialog)) return;
		this.responding.set(dialog.id);
		const { approval, request, target } = dialog;
		try {
			if (approval) {
				const approved = "confirmed" in response && response.confirmed;
				if (approved)
					await this.client.approveProjectMcpServer(
						target.projectId,
						approval.server,
					);
				approval.finish(approved);
			} else {
				// Pi uses the original request ID and does not send a normal RPC reply.
				await this.client.sendChatCommand(target.sessionKey, {
					type: "extension_ui_response",
					id: request.id,
					...response,
				});
			}
		} catch (error) {
			approval?.finish(false);
			this.toasts.show({
				variant: "error",
				title: t("chat.respondExtensionFailed"),
				description: userErrorMessage(error),
			});
		} finally {
			this.remove(dialog);
			this.responding.set(null);
		}
	}

	dispose() {
		this.disposed = true;
		for (const dialog of this.pending()) this.remove(dialog);
		for (const dialog of this.approvals.values())
			dialog.approval?.finish(false);
		this.approvals.clear();
	}

	private remove(dialog: PendingDialog) {
		clearTimeout(dialog.timer);
		this.pending.update((pending) => pending.filter((item) => item !== dialog));
	}
}

export function RemoteExtensionDialog(props: {
	ui: RemoteExtensionUi;
	sessionKey: Accessor<string | null>;
}) {
	return (
		<Each
			of={props.ui.dialog(props.sessionKey() ?? undefined)}
			key={(dialog) => dialog.id}
		>
			{(dialog) => <ExtensionDialog dialog={dialog()} ui={props.ui} />}
		</Each>
	);
}

function ExtensionDialog(props: {
	dialog: PendingDialog;
	ui: RemoteExtensionUi;
}) {
	const { request, id, expiresAtMs } = props.dialog;
	const title = request.title || t("chat.extensionPromptTitle");
	const value = signal(request.prefill ?? "");
	const remainingSeconds = signal<number | null>(
		expiresAtMs
			? Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000))
			: null,
	);
	const viewport = MobileViewport();
	if (expiresAtMs) {
		const interval = setInterval(() => {
			const next = Math.max(0, Math.ceil((expiresAtMs - Date.now()) / 1000));
			remainingSeconds.set(next);
			if (next === 0) clearInterval(interval);
		}, 1000);
		cleanup(() => clearInterval(interval));
	}
	const busy = () => props.ui.busy(id);
	const respond = (response: Response) =>
		void props.ui.respond(props.dialog, response);
	const cancel = () => respond({ cancelled: true });
	return (
		<Dialog
			open
			accessibilityLabel={title}
			closeOnEscape={!busy()}
			style={{ maxHeight: Math.max(160, viewport.availableHeight() - 32) }}
			onOpenChange={({ open }) => {
				if (!open) cancel();
			}}
		>
			<DialogTitle>{title}</DialogTitle>
			<View class="gap-3">
				{request.message ? (
					<DialogDescription>{request.message}</DialogDescription>
				) : null}
				{() => {
					const seconds = remainingSeconds();
					return seconds !== null && seconds > 0 ? (
						<Text class="font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-muted-foreground">
							{t("chat.extensionTimeoutSeconds", { seconds })}
						</Text>
					) : null;
				}}
				{request.method === "select"
					? request.options.map((option) => (
							<Button
								variant="outline"
								class="min-h-11"
								disabled={busy()}
								onPress={() => respond({ value: option })}
							>
								<Text>{option}</Text>
							</Button>
						))
					: null}
				{request.method === "input" ? (
					<Input
						accessibilityLabel={title}
						value={value()}
						placeholder={request.placeholder ?? undefined}
						disabled={busy()}
						style={{ fontSize: webInputFontSize(token("pilo-ui-text-sm")) }}
						onChange={({ value: next }) => value.set(next)}
						onSubmit={() => respond({ value: value() })}
					/>
				) : request.method === "editor" ? (
					<Textarea
						rows={6}
						accessibilityLabel={title}
						value={value()}
						disabled={busy()}
						style={{ fontSize: webInputFontSize(token("pilo-ui-text-sm")) }}
						onChange={({ value: next }) => value.set(next)}
					/>
				) : null}
			</View>
			<View class="flex-row justify-end gap-2">
				<Button
					variant="ghost"
					class="min-h-11"
					disabled={busy()}
					onPress={
						request.method === "confirm"
							? () => respond({ confirmed: false })
							: cancel
					}
				>
					<Text>{() => t("common.cancel")}</Text>
				</Button>
				{request.method !== "select" ? (
					<Button
						class="min-h-11"
						disabled={busy()}
						onPress={() =>
							respond(
								request.method === "confirm"
									? { confirmed: true }
									: { value: value() },
							)
						}
					>
						<Text>{() => t("common.confirm")}</Text>
					</Button>
				) : null}
			</View>
		</Dialog>
	);
}
