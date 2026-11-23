import { type Accessor, effect, signal, windowSize } from "nsh";

import type { RemoteHostState } from "@shared/api/remote-types";
import { AppToaster, AppToasts, AppToastStack } from "../app/app-toasts";
import { t } from "../app/i18n";
import { Dialog } from "../ui/dialog";
import { DialogClose } from "../ui/dialog-close";
import { DialogHeader } from "../ui/dialog-header";
import { DialogTitle } from "../ui/dialog-title";
import { SETTINGS_SM_WIDTH } from "./layout";
import { RemotePane } from "./remote-pane";
import type { SettingsClient } from "./settings-dialog";

const POLL_MS = 3_000;
const MAX_WIDTH = 600;

/**
 * The Remote Host's state behind the sidebar's phone button, as React's
 * `useRemoteStatus`: polled (no Host event), paused while the dialog is
 * open since its pane refreshes the same state.
 */
export function createRemoteStatus(
	client: Pick<SettingsClient, "remoteHostState">,
	paused: Accessor<boolean>,
) {
	const state = signal<RemoteHostState | null>(null);
	const refresh = async () => {
		try {
			state.set(await client.remoteHostState());
		} catch {
			// Unavailable: keep what shows until the next poll.
		}
	};
	effect(() => {
		void refresh();
		if (paused()) return;
		const timer = setInterval(() => void refresh(), POLL_MS);
		return () => clearInterval(timer);
	});
	return {
		state,
		running: () => state()?.running ?? false,
		refresh,
	};
}

/** The Remote WebUI dialog the sidebar footer opens, as React's. */
export function RemoteDialog(props: {
	client: SettingsClient;
	initialState: RemoteHostState | null;
	onClose: () => void;
}) {
	const toasts = new AppToasts();
	const width = () => {
		const win = windowSize().width;
		return Math.min(MAX_WIDTH, win - (win < SETTINGS_SM_WIDTH ? 32 : 64));
	};
	return (
		<Dialog
			testID="remote-dialog"
			accessibilityLabel={t("settings.remote")}
			accessibilityDescription={t("settings.remoteDescription")}
			onOpenChange={({ open }) => {
				if (!open) props.onClose();
			}}
			style={{ width: width(), maxWidth: MAX_WIDTH }}
		>
			<DialogHeader>
				<DialogTitle>{() => t("settings.remote")}</DialogTitle>
			</DialogHeader>
			<AppToaster.Provider value={toasts}>
				<RemotePane client={props.client} initialState={props.initialState} />
			</AppToaster.Provider>
			<DialogClose
				testID="remote-dialog-close"
				accessibilityLabel={t("common.close")}
				onPress={props.onClose}
			/>
			{/* A window-level overlay would be behind the native dialog. */}
			<AppToastStack toasts={toasts} />
		</Dialog>
	);
}
