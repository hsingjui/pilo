import { type Accessor, effect, signal, View, windowSize } from "nsh";

import type { RemoteHostState } from "@/lib/api/remote-types";
import { AppToaster, AppToasts, AppToastStack } from "../app/app-toasts";
import { t } from "../app/i18n";
import { Button } from "../ui/button";
import { Dialog } from "../ui/dialog";
import { DialogTitle } from "../ui/dialog-title";
import { Icon } from "../ui/icon";
import { RemotePane } from "./remote-pane";
import type { SettingsClient } from "./settings-dialog";

const POLL_MS = 3_000;
/** Tailwind's sm:, as the React dialog's `sm:w-[calc(100vw-4rem)]`. */
const SM_WIDTH = 640;
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
		return Math.min(MAX_WIDTH, win - (win < SM_WIDTH ? 32 : 64));
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
			<View class="flex-row items-center justify-between gap-2">
				<DialogTitle class="min-w-0 flex-1">
					{() => t("settings.remote")}
				</DialogTitle>
				<Button
					testID="remote-dialog-close"
					variant="ghost"
					size="icon"
					class="size-8 shrink-0"
					accessibilityLabel={t("common.close")}
					onPress={props.onClose}
				>
					<Icon name="X" size={16} />
				</Button>
			</View>
			<AppToaster.Provider value={toasts}>
				<RemotePane client={props.client} initialState={props.initialState} />
			</AppToaster.Provider>
			{/* A window-level overlay would be behind the native dialog. */}
			<AppToastStack toasts={toasts} />
		</Dialog>
	);
}
