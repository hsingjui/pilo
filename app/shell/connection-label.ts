import type { Connection } from "@shared/api/pi-runtime-types";
import { hostPerspective } from "../hosts/host-perspective";
import { t } from "./i18n";

/** A connection's name as the shown Host sees it: a remote Host's Local is that Host's machine. */
export function connectionLabel(
	connection: Connection,
	remoteName = hostPerspective().remoteName,
): string {
	if (connection.kind.type !== "local" || connection.name !== "Local") {
		return connection.name;
	}
	return remoteName
		? t("hosts.localOf", { name: remoteName })
		: t("common.local");
}
