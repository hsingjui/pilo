import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Input } from "@/ui";
import {
	CUSTOM_THEME_BASE,
	CUSTOM_THEME_CATALOG,
	validateWebThemeTokens,
} from "@/lib/theme-web";
import {
	parseThemeColor,
	isColorKind,
	type CustomThemeTokens,
	type ThemeTokenScope,
} from "@/lib/theme-tokens";

export function editableThemeTokens(
	tokens: CustomThemeTokens,
): CustomThemeTokens {
	const theme = { ...tokens.theme };
	const light = { ...tokens.light };
	for (const [token, value] of Object.entries(theme)) {
		const kind = CUSTOM_THEME_CATALOG.get(token);
		if (kind && isColorKind(kind)) {
			light[token] = value;
			delete theme[token];
		}
	}
	return { theme, light, dark: { ...tokens.dark } };
}

export function themeTokensKey(tokens: CustomThemeTokens): string {
	const editable = editableThemeTokens(tokens);
	return JSON.stringify(
		(["theme", "light", "dark"] as const).map((scope) =>
			[...CUSTOM_THEME_CATALOG.keys()].map(
				(token) => editable[scope]?.[token] ?? "",
			),
		),
	);
}

const GROUPS = [
	["color", "settings.themeColors"],
	["length", "settings.themeLengths"],
	["number", "settings.themeNumbers"],
	["font", "settings.themeFonts"],
] as const;

export function ThemeTokenEditor({
	tokens,
	onChange,
}: {
	tokens: CustomThemeTokens;
	onChange: (tokens: CustomThemeTokens) => void;
}) {
	const { t } = useTranslation();
	const [search, setSearch] = useState("");
	const validation = validateWebThemeTokens(tokens);
	const issues = validation.ok ? [] : validation.issues;
	const visible = [...CUSTOM_THEME_CATALOG].filter(([token]) =>
		token.includes(search.trim().toLowerCase()),
	);
	function change(scope: ThemeTokenScope, token: string, value: string) {
		const entries = { ...tokens[scope] };
		if (value === "") delete entries[token];
		else entries[token] = value;
		onChange({ ...tokens, [scope]: entries });
	}
	return (
		<div className="space-y-4">
			<label
				htmlFor="theme-token-search"
				className="block text-xs text-muted-foreground"
			>
				{t("settings.themeTokenSearch")}
			</label>
			<Input
				id="theme-token-search"
				aria-label={t("settings.themeTokenSearch")}
				placeholder={t("settings.themeTokenSearch")}
				value={search}
				onChange={(event) => setSearch(event.target.value)}
				className="min-h-11"
			/>
			<p className="text-xs text-muted-foreground">
				{t("settings.themeTokensHint")}
			</p>
			{visible.length === 0 ? (
				<output className="text-sm text-muted-foreground">
					{t("settings.themeNoTokens")}
				</output>
			) : null}
			{GROUPS.map(([kind, label]) => {
				const rows = visible.filter(([, tokenKind]) =>
					kind === "color" ? isColorKind(tokenKind) : tokenKind === kind,
				);
				return rows.length ? (
					<fieldset key={kind} className="min-w-0 space-y-3">
						<legend className="mb-2 text-sm font-medium">{t(label)}</legend>
						{rows.map(([token]) => (
							<div
								key={token}
								className="min-w-0 space-y-2 rounded-md border p-3"
							>
								<div className="break-all font-mono text-xs">{token}</div>
								<div
									className={
										kind === "color"
											? "grid gap-3 sm:grid-cols-2"
											: "grid gap-3"
									}
								>
									{(kind === "color"
										? (["light", "dark"] as const)
										: (["theme"] as const)
									).map((scope) => {
										const value = tokens[scope]?.[token] ?? "";
										const base = {
											...CUSTOM_THEME_BASE.theme,
											...CUSTOM_THEME_BASE.light,
											...(scope === "dark" ? CUSTOM_THEME_BASE.dark : {}),
										};
										const placeholder = String(Reflect.get(base, token) ?? "");
										const issue = issues.find(
											(item) =>
												"token" in item &&
												item.token === token &&
												item.scope === scope,
										);
										const id = `theme-token-${scope}-${token}`;
										const parsedColor =
											kind === "color" ? parseThemeColor(value) : undefined;
										const color =
											kind === "color"
												? parseThemeColor(value || placeholder)
												: undefined;
										return (
											<div key={scope} className="min-w-0 space-y-1.5">
												<label
													htmlFor={id}
													className="text-xs text-muted-foreground"
												>
													{scope === "light"
														? t("settings.light")
														: scope === "dark"
															? t("settings.dark")
															: t("settings.themeTokenValue")}
												</label>
												<div className="flex min-w-0 items-center gap-2">
													{kind === "color" ? (
														<span
															aria-hidden="true"
															className="size-6 shrink-0 rounded border"
															style={{
																backgroundColor: color ?? "transparent",
															}}
														/>
													) : null}
													<Input
														id={id}
														aria-label={`${token} ${scope}`}
														aria-invalid={Boolean(issue)}
														aria-describedby={issue ? `${id}-error` : undefined}
														value={value}
														placeholder={placeholder}
														onChange={(event) =>
															change(scope, token, event.target.value)
														}
														autoCapitalize="off"
														autoCorrect="off"
														spellCheck={false}
														className="min-h-11 min-w-0 font-mono text-xs"
													/>
												</div>
												{issue ? (
													<p
														id={`${id}-error`}
														role="alert"
														className="text-xs text-destructive"
													>
														{t(
															issue.code === "invalid-value" &&
																issue.expected === "opaque-color" &&
																parsedColor !== undefined &&
																!parsedColor.endsWith("ff")
																? "settings.themeTokenAlphaError"
																: kind === "color"
																	? "settings.themeTokenColorError"
																	: "settings.themeTokenInvalid",
															{ kind: t(label) },
														)}
													</p>
												) : null}
											</div>
										);
									})}
								</div>
							</div>
						))}
					</fieldset>
				) : null;
			})}
		</div>
	);
}
