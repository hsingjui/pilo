import { i18n } from "../../i18n/index.ts";
import type { Connection } from "@/lib/api/pi-runtime";

export * from "./projects-types";

export function connectionLabel(connection: Connection): string {
	return connection.kind.type === "local"
		? i18n.t("common.local")
		: connection.name;
}
