import { type Accessor, type JSX, Text, View } from "nsh";

import { classNames } from "../ui/class-names";
import { Icon, type IconName } from "../ui/icon";
import type { SshFieldError } from "./ssh-connection-draft";

/** A labeled form field: caption above, control below, optional extra footer. */
export function field(
	label: string,
	child: JSX.Element,
	options?: {
		class?: string;
		labelIcon?: IconName;
		footer?: JSX.Element;
	},
) {
	return (
		<View class={classNames("gap-1", options?.class)}>
			{options?.labelIcon ? (
				<View class="flex-row items-center gap-1">
					<Icon name={options.labelIcon} size={14} />
					<Text class="font-sans text-xs">{label}</Text>
				</View>
			) : (
				<Text class="font-sans text-xs">{label}</Text>
			)}
			{child}
			{options?.footer}
		</View>
	);
}

/**
 * The per-field error line the SSH editor shows under a failed field, in
 * place of React's toast.
 */
export function fieldError(
	error: Accessor<SshFieldError | null>,
	fieldName: SshFieldError["field"],
) {
	return () =>
		error()?.field === fieldName ? (
			<Text
				testID={`settings-ssh-error-${fieldName}`}
				class="font-sans text-[11px] text-destructive"
			>
				{error()?.message}
			</Text>
		) : null;
}
