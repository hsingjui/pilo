import { type Accessor, type JSX, Text, View } from "nsh";

import { Tooltip } from "../ui/tooltip";
import type { SshFieldError } from "./ssh-connection-draft";

/** A tooltip body used for icon-only controls. */
export function hint(label: string) {
	return (
		<Tooltip>
			<Text class="font-sans">{label}</Text>
		</Tooltip>
	);
}

/** A labeled form field: caption above, control below. */
export function field(label: string, child: JSX.Element) {
	return (
		<View class="gap-1">
			<Text class="font-sans text-xs">{label}</Text>
			{child}
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
