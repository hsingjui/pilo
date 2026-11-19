import "i18next";

import { defaultNS, resources } from "@/i18n/options";

declare module "i18next" {
	interface CustomTypeOptions {
		defaultNS: typeof defaultNS;
		resources: (typeof resources)["en-US"];
		strictKeyChecks: true;
	}
}
