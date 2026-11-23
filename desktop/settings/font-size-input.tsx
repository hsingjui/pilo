import { signal } from "nsh";

import { t } from "../app/i18n";
import { NumberInput } from "../ui/number-input";

/**
 * A font size field, as `font-size-input.tsx` in the WebUI: typing edits a
 * draft that commits clamped on blur or Enter and reverts on Escape or an
 * empty/invalid field; a `px` suffix sits in the field.
 */
export function FontSizeInput(props: {
	value: number;
	min: number;
	max: number;
	/** The font field's name ("Interface"), used in the accessibility label. */
	label: string;
	onChange: (value: number) => void;
	class?: string;
	testID?: string;
}) {
	/** The value the field read as, while it is being edited (`null` = empty). */
	const draft = signal<number | null | undefined>(undefined);
	const clamp = (value: number) =>
		Math.min(props.max, Math.max(props.min, value));
	const commit = () => {
		const next = draft();
		draft.set(undefined);
		if (next === undefined || next === null) return;
		const clamped = clamp(next);
		if (clamped !== props.value) props.onChange(clamped);
	};
	return (
		<NumberInput
			testID={props.testID}
			size="sm"
			class={props.class}
			suffix="px"
			onKeyDown={(event) => {
				if (event.key === "Escape") draft.set(undefined);
			}}
			value={draft() ?? props.value}
			min={props.min}
			max={props.max}
			step={1}
			accessibilityLabel={String(
				t("settings.fontSizeInputLabel", { font: props.label }),
			)}
			onChange={({ value }) => draft.set(value)}
			onSubmit={commit}
			onBlur={commit}
		/>
	);
}
