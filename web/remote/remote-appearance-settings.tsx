import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";
import { Palette } from "lucide-react";
import { useTheme } from "@/lib/theme-provider";
import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogTitle,
} from "@/ui";

const AppearanceSettings = lazy(() =>
	import("@/components/settings/appearance-settings").then((module) => ({
		default: module.AppearanceSettings,
	})),
);

export function RemoteAppearanceSettings() {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const { supportsThemeTokens } = useTheme();
	if (!supportsThemeTokens) return null;
	return (
		<>
			<Button
				variant="ghost"
				size="icon"
				className="min-h-11 min-w-11"
				aria-label={t("settings.theme")}
				onClick={() => setOpen(true)}
			>
				<Palette />
			</Button>
			{open ? (
				<Dialog open onOpenChange={setOpen}>
					<DialogContent className="max-h-[90dvh] w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto p-3 pt-10 sm:p-6">
						<DialogTitle>{t("settings.theme")}</DialogTitle>
						<DialogDescription className="sr-only">
							{t("settings.themeTokensHint")}
						</DialogDescription>
						<Suspense fallback={null}>
							<AppearanceSettings />
						</Suspense>
					</DialogContent>
				</Dialog>
			) : null}
		</>
	);
}
