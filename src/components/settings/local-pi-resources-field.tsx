import { useId } from "react";
import { useTranslation } from "react-i18next";
import { Switch } from "@/ui";

export function LocalPiResourcesField({
	checked,
	disabled,
	onCheckedChange,
}: {
	checked: boolean;
	disabled?: boolean;
	onCheckedChange: (checked: boolean) => void;
}) {
	const id = useId();
	const { t } = useTranslation();
	return (
		<div className="flex items-start gap-3 text-xs">
			<label htmlFor={id} className="min-w-0 flex-1 cursor-pointer py-2">
				{t("connection.localPiResources")}
				<span
					id={`${id}-description`}
					className="mt-1 block text-muted-foreground"
				>
					{t("connection.localPiResourcesDescription")}
				</span>
			</label>
			<Switch
				id={id}
				aria-describedby={`${id}-description`}
				className="mt-2"
				checked={checked}
				disabled={disabled}
				onCheckedChange={onCheckedChange}
			/>
		</div>
	);
}
