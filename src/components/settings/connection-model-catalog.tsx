import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { RefreshCw } from "lucide-react";

import type { Connection, PiModel } from "@/lib/api/pi-runtime";
import type { PiloClient } from "@/lib/api/pilo-client";
import { useConnectionModels } from "@/lib/use-connection-models";
import { Button, Hint } from "@/ui";
import { SETTINGS_ICON_BUTTON_CLASS } from "./compact-layout";

/** Shared loading, refresh and errors for every connection-scoped model setting. */
export function ConnectionModelCatalog({
	client,
	connection,
	children,
}: {
	client: PiloClient;
	connection: Connection;
	children: (models: readonly PiModel[], refresh: ReactNode) => ReactNode;
}) {
	const { t } = useTranslation();
	const catalog = useConnectionModels(client, connection);
	return (
		<div className="min-w-0" aria-busy={catalog.loading}>
			{children(
				catalog.models,
				<Hint key="refresh-models" label={t("settings.refreshModels")}>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className={`${SETTINGS_ICON_BUTTON_CLASS} [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11`}
						disabled={catalog.loading}
						onClick={() => void catalog.refresh()}
						aria-label={t("settings.refreshModels")}
					>
						<RefreshCw
							className={
								catalog.loading
									? "animate-spin motion-reduce:animate-none"
									: undefined
							}
						/>
					</Button>
				</Hint>,
			)}
			{catalog.error ? (
				<p
					role="alert"
					className="break-words px-3 py-2 text-xs text-destructive"
				>
					{t("settings.refreshModelsFailed")} {catalog.error}
				</p>
			) : null}
		</div>
	);
}
