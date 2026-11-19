import { useId } from "react";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import type { ThemeCustomConversion } from "@/lib/theme-settings-types";

export function ThemeConversionNotice({
	conversion,
	savedThemeName,
}: {
	conversion?: ThemeCustomConversion;
	savedThemeName?: string;
}) {
	const { t } = useTranslation();
	const titleId = useId();
	const issues = savedThemeName
		? conversion?.savedThemes.find((theme) => theme.name === savedThemeName)
				?.issues
		: conversion?.current;
	if (!issues?.length) return null;
	return (
		<section
			aria-labelledby={titleId}
			className="min-w-0 rounded-lg border border-border bg-muted/30 p-3"
		>
			<div className="flex items-start gap-2">
				<TriangleAlert
					aria-hidden="true"
					className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
				/>
				<div className="min-w-0 space-y-1">
					<h3 id={titleId} className="text-sm font-medium">
						{t("settings.themeConversionTitle", { count: issues.length })}
					</h3>
					<p className="text-xs leading-relaxed text-muted-foreground">
						{t("settings.themeConversionHint")}
					</p>
				</div>
			</div>
			<section
				aria-label={t("settings.themeConversionDetails")}
				// oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard users need to scroll this read-only region.
				tabIndex={0}
				className="mt-3 max-h-64 overflow-auto rounded-md border border-border bg-background focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring/60"
			>
				<ul className="divide-y divide-border">
					{issues.map((issue, index) => (
						<li
							// oxlint-disable-next-line react/no-array-index-key -- Duplicate CSS diagnostics must remain distinct.
							key={`${JSON.stringify(issue)}:${index}`}
							className="min-w-0 space-y-1.5 p-3"
						>
							<p className="text-xs font-medium">
								{t(`settings.themeConversionReasons.${issue.reason}`)}
							</p>
							{issue.selector ? (
								<p className="[overflow-wrap:anywhere] font-mono text-xs text-muted-foreground">
									{issue.selector}
								</p>
							) : null}
							<pre className="whitespace-pre-wrap [overflow-wrap:anywhere] font-mono text-xs leading-relaxed">
								{issue.text}
							</pre>
						</li>
					))}
				</ul>
			</section>
		</section>
	);
}
