import type { Connection } from "@shared/api/pi-runtime-types";
import { t } from "./i18n";

export function connectionLabel(connection: Connection): string {
	return connection.kind.type === "local" && connection.name === "Local"
		? t("common.local")
		: connection.name;
}
