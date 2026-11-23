import { type Bounds, context, type JSX, signal, View } from "nsh";

export const SessionGlideContext = context<{
	show: (bounds: Bounds | null) => void;
} | null>(null);

/**
 * A list of session rows whose hover highlight slides from row to row (the
 * WebUI `SessionRowGlide`), which follows the pointer more closely than each
 * row fading its own background.
 */
export function SessionGlide(props: { children?: JSX.Element }) {
	const highlight = signal<{ top: number; height: number } | null>(null);
	const last = signal({ top: 0, height: 0 });
	const glide = {
		show: (bounds: Bounds | null) => {
			if (!bounds) return;
			const next = { top: bounds.origin.y, height: bounds.size.height };
			last.set(next);
			highlight.set(next);
		},
	};
	return (
		<View
			class="relative w-full min-w-0 gap-(--pilo-sidebar-session-gap)"
			onMouseLeave={() => highlight.set(null)}
		>
			<View
				class="pointer-events-none absolute inset-x-0 top-0 rounded-md bg-sidebar-hover transition duration-150 ease-out"
				style={{
					height: last().height,
					opacity: highlight() ? 1 : 0,
					transform: [{ translateY: last().top }],
				}}
			/>
			<SessionGlideContext.Provider value={glide}>
				{props.children}
			</SessionGlideContext.Provider>
		</View>
	);
}
