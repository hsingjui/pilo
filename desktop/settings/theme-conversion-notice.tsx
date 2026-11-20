import { Scroll, Text, token, View } from "nsh";

import type {
	ThemeConversionIssue,
	ThemeCustomConversion,
} from "@/lib/theme-settings-types";
import { t } from "../app/i18n";
import { Icon } from "../ui/icon";
import { scrollbarLook } from "../ui/scrollbar";

function IssueRow(props: { issue: ThemeConversionIssue; last: boolean }) {
	return (
		<View
			class={`min-w-0 gap-1.5 p-3 ${props.last ? "" : "border-b border-border"}`}
		>
			<Text class="font-sans text-xs font-medium">
				{() =>
					String(t(`settings.themeConversionReasons.${props.issue.reason}`))
				}
			</Text>
			{props.issue.selector ? (
				<Text class="font-mono text-xs text-muted-foreground">
					{props.issue.selector}
				</Text>
			) : null}
			<Text class="font-mono text-xs leading-relaxed">{props.issue.text}</Text>
		</View>
	);
}

/**
 * The unconverted-CSS report for the current draft's source theme, as
 * `theme-conversion-notice.tsx` in the Tauri app.
 */
export function ThemeConversionNotice(props: {
	conversion?: ThemeCustomConversion;
	savedThemeName?: string;
}) {
	const issues = () =>
		(props.savedThemeName
			? props.conversion?.savedThemes.find(
					(theme) => theme.name === props.savedThemeName,
				)?.issues
			: props.conversion?.current) ?? [];
	return (
		<View>
			{() => {
				const list = issues();
				return list.length ? (
					<View class="min-w-0 rounded-lg border border-border bg-muted/30 p-3">
						<View class="flex-row items-start gap-2">
							<Icon
								name="TriangleAlert"
								size={16}
								color={token("status-warning")}
								class="mt-0.5 shrink-0"
							/>
							<View class="min-w-0 gap-1">
								<Text class="font-sans text-sm font-medium">
									{() =>
										String(
											t("settings.themeConversionTitle", {
												count: list.length,
											}),
										)
									}
								</Text>
								<Text class="font-sans text-xs leading-relaxed text-muted-foreground">
									{() => String(t("settings.themeConversionHint"))}
								</Text>
							</View>
						</View>
						<Scroll
							testID="settings-theme-conversion-details"
							accessibilityLabel={t("settings.themeConversionDetails")}
							class="mt-3 max-h-64 rounded-md border border-border bg-background"
							scrollbar={{ vertical: scrollbarLook() }}
						>
							{list.map((issue, index) => (
								<IssueRow issue={issue} last={index === list.length - 1} />
							))}
						</Scroll>
					</View>
				) : null;
			}}
		</View>
	);
}
