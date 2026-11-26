import { token } from "nsh";

/**
 * Inset selection ring matching React's `ring-[length:var(--pilo-mobile-selected-ring-width)]
 * ring-inset ring-sidebar-foreground/10` without inflating 44px row heights via borders.
 */
export function mobileSelectedRingStyle(claudeTheme: boolean) {
	if (claudeTheme) return undefined;
	return {
		boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${token("sidebar-foreground")} 10%, transparent)`,
	};
}
