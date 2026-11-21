import { signal, Text, View } from "nsh";
import { NumberInput } from "nsh/base";

import { t } from "../app/i18n";
import { classNames } from "../ui/class-names";
import { styleVar } from "../ui/theme-style";

/**
 * A font size field, as `font-size-input.tsx` in the Tauri app: typing edits a
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
		<View
			class={classNames(
				"h-(--pilo-field-height) flex-row items-center rounded-(--pilo-radius-md) border border-input-border bg-input-field pr-3",
				props.class,
			)}
			style={{ boxShadow: styleVar("pilo-field-shadow") }}
			onKeyDown={(event) => {
				if (event.key === "Escape") draft.set(undefined);
			}}
		>
			{/* The field look wraps the steppers too, as in Tauri; the suffix slot
			 * wraps under the field in this nsh build, so `px` is a sibling. */}
			<NumberInput
				testID={props.testID}
				class="min-w-0 flex-1 border-0 bg-transparent"
				inputClass="shadow-none"
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
			<Text class="font-sans shrink-0 text-xs text-muted-foreground">px</Text>
		</View>
	);
}
