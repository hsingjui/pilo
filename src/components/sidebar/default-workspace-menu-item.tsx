import { useTranslation } from "react-i18next";
import { usePreferences } from "@/lib/preferences-provider";
import { DropdownMenuCheckboxItem } from "@/ui";

export function DefaultWorkspaceMenuItem({
	connectionId,
}: {
	connectionId: string;
}) {
	const { t } = useTranslation();
	const { defaultWorkspaceVisibility, setDefaultWorkspaceShown } =
		usePreferences();
	return (
		<DropdownMenuCheckboxItem
			checked={defaultWorkspaceVisibility[connectionId] === true}
			onCheckedChange={(shown) => setDefaultWorkspaceShown(connectionId, shown)}
		>
			{t("sidebar.showDefaultWorkspace")}
		</DropdownMenuCheckboxItem>
	);
}
