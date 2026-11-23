import { token } from "nsh";

/**
 * Mobile WebUI text scale matching React's `@media (max-width: 1023px)` overrides
 * in `web/index.css` (16/14 ratio on Tailwind sizes without scaling rem geometry).
 */
export const MOBILE_TEXT = {
	"2xs": { fontSize: 12.5, lineHeight: 16 },
	xs: { fontSize: 13.75, lineHeight: 18 },
	segment: { fontSize: 14, lineHeight: 16 },
	sm: { fontSize: 16, lineHeight: 20 },
	smRelaxed: { fontSize: 16, lineHeight: 24 },
	base: { fontSize: 18.25, lineHeight: 26 },
	lg: { fontSize: 20.5, lineHeight: 28 },
} as const;

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
