import {
	type Accessor,
	computed,
	List,
	signal,
	Text,
	View,
	windowSize,
} from "nsh";

import {
	isColorKind,
	parseThemeColor,
	validateCustomThemeTokens,
	type CustomThemeTokens,
	type ThemeTokenIssue,
	type ThemeTokenKind,
	type ThemeTokenScope,
} from "@/lib/theme-tokens";
import { CUSTOM_THEME_BASE, CUSTOM_THEME_CATALOG } from "@/lib/theme-web";
import { t } from "../app/i18n";
import { Input } from "../ui/input";

const GROUPS = [
	["color", "settings.themeColors"],
	["length", "settings.themeLengths"],
	["number", "settings.themeNumbers"],
	["font", "settings.themeFonts"],
] as const;
type GroupKind = (typeof GROUPS)[number][0];

type Row =
	| { type: "header"; title: string }
	| {
			type: "token";
			token: string;
			kind: ThemeTokenKind;
			group: GroupKind;
	  };

/** Tailwind's sm:, measured on the window as the Tauri's viewport. */
const SM_WIDTH = 640;
const narrow = () => windowSize().width < SM_WIDTH;

/** The catalog's base value a token field shows as its placeholder. */
function baseValue(scope: ThemeTokenScope, token: string): string {
	const base = {
		...CUSTOM_THEME_BASE.theme,
		...CUSTOM_THEME_BASE.light,
		...(scope === "dark" ? CUSTOM_THEME_BASE.dark : {}),
	};
	return String(Reflect.get(base, token) ?? "");
}

/** One token's per-scope field: label, optional swatch, input, error line. */
function TokenField(props: {
	tokens: Accessor<CustomThemeTokens>;
	issues: Accessor<ThemeTokenIssue[]>;
	token: string;
	scope: ThemeTokenScope;
	color: boolean;
	labelKey: (typeof GROUPS)[number][1];
	onChange: (scope: ThemeTokenScope, token: string, value: string) => void;
}) {
	const id = `settings-token-${props.scope}-${props.token}`;
	const color = props.color;
	return (
		<View class="min-w-0 flex-1 gap-1.5">
			<Text class="text-xs text-muted-foreground">
				{() =>
					String(
						t(
							props.scope === "light"
								? "settings.light"
								: props.scope === "dark"
									? "settings.dark"
									: "settings.themeTokenValue",
						),
					)
				}
			</Text>
			<View class="min-w-0 flex-row items-center gap-2">
				{color ? (
					<View>
						{() => {
							const value = props.tokens()[props.scope]?.[props.token] ?? "";
							const swatch = parseThemeColor(
								value || baseValue(props.scope, props.token),
							);
							return (
								<View
									class="size-6 shrink-0 rounded border border-border"
									style={{
										backgroundColor: swatch ?? "transparent",
									}}
								/>
							);
						}}
					</View>
				) : null}
				<Input
					testID={id}
					class="min-w-0 flex-1 font-mono text-xs"
					accessibilityLabel={`${props.token} ${props.scope}`}
					value={props.tokens()[props.scope]?.[props.token] ?? ""}
					placeholder={baseValue(props.scope, props.token)}
					autoCapitalize="none"
					autoCorrect={false}
					onChange={(event) =>
						props.onChange(props.scope, props.token, event.value)
					}
				/>
			</View>
			{() => {
				const issue = props
					.issues()
					.find(
						(item) =>
							"token" in item &&
							item.token === props.token &&
							item.scope === props.scope,
					);
				if (!issue) return null;
				const value = props.tokens()[props.scope]?.[props.token] ?? "";
				const parsedColor = color ? parseThemeColor(value) : undefined;
				const label = String(t(props.labelKey));
				const message =
					issue.code === "invalid-value" &&
					issue.expected === "opaque-color" &&
					parsedColor !== undefined &&
					!parsedColor.endsWith("ff")
						? t("settings.themeTokenAlphaError")
						: color
							? t("settings.themeTokenColorError")
							: t("settings.themeTokenInvalid", { kind: label });
				return (
					<Text class="font-sans text-xs text-destructive">
						{String(message)}
					</Text>
				);
			}}
		</View>
	);
}

/** One token's card: its name and its per-appearance fields. */
function TokenCard(props: {
	tokens: Accessor<CustomThemeTokens>;
	issues: Accessor<ThemeTokenIssue[]>;
	token: string;
	kind: ThemeTokenKind;
	onChange: (scope: ThemeTokenScope, token: string, value: string) => void;
}) {
	const color = isColorKind(props.kind);
	const group: GroupKind = color ? "color" : (props.kind as GroupKind);
	const labelKey = GROUPS.find(([kind]) => kind === group)?.[1];
	const scopes: ThemeTokenScope[] = color ? ["light", "dark"] : ["theme"];
	return (
		<View class="min-w-0 gap-2 rounded-md border border-border p-3">
			<Text class="font-mono text-xs">{props.token}</Text>
			{() => (
				<View
					class={
						color && !narrow() ? "min-w-0 flex-row gap-3" : "min-w-0 gap-3"
					}
				>
					{scopes.map((scope) => (
						<TokenField
							tokens={props.tokens}
							issues={props.issues}
							token={props.token}
							scope={scope}
							color={color}
							labelKey={labelKey ?? "settings.themeColors"}
							onChange={props.onChange}
						/>
					))}
				</View>
			)}
		</View>
	);
}

/**
 * The per-token table of a custom theme, as `ThemeTokenEditor` in the Tauri
 * app: a filter, then one card per catalog token grouped by kind. Values are
 * the caller's draft; an empty field keeps the base theme's (shown as the
 * placeholder).
 */
export function ThemeTokenEditor(props: {
	tokens: Accessor<CustomThemeTokens>;
	onChange: (tokens: CustomThemeTokens) => void;
}) {
	const search = signal("");
	const issues = computed(() => {
		const result = validateCustomThemeTokens(
			props.tokens(),
			CUSTOM_THEME_CATALOG,
		);
		return result.ok ? [] : result.issues;
	});
	const rows = computed((): Row[] => {
		const query = search().trim().toLowerCase();
		const visible = [...CUSTOM_THEME_CATALOG].filter(([token]) =>
			token.includes(query),
		);
		const list: Row[] = [];
		for (const [kind, label] of GROUPS) {
			const group = visible.filter(([, tokenKind]) =>
				kind === "color" ? isColorKind(tokenKind) : tokenKind === kind,
			);
			if (!group.length) continue;
			list.push({ type: "header", title: String(t(label)) });
			for (const [token, tokenKind] of group)
				list.push({ type: "token", token, kind: tokenKind, group: kind });
		}
		return list;
	});
	const change = (scope: ThemeTokenScope, token: string, value: string) => {
		const current = props.tokens();
		const entries = { ...current[scope] };
		if (value === "") delete entries[token];
		else entries[token] = value;
		props.onChange({ ...current, [scope]: entries });
	};
	return (
		<View class="gap-3">
			<View class="gap-1">
				<Text class="text-xs text-muted-foreground">
					{() => String(t("settings.themeTokenSearch"))}
				</Text>
				<Input
					testID="settings-theme-token-search"
					accessibilityLabel={t("settings.themeTokenSearch")}
					placeholder={t("settings.themeTokenSearch")}
					value={search()}
					onChange={(event) => search.set(event.value)}
				/>
			</View>
			<Text class="text-xs text-muted-foreground">
				{() => String(t("settings.themeTokensHint"))}
			</Text>
			{() =>
				rows().length === 0 ? (
					<Text class="text-sm text-muted-foreground">
						{() => String(t("settings.themeNoTokens"))}
					</Text>
				) : (
					<List
						testID="settings-theme-token-list"
						viewport="parent"
						each={rows()}
						keyExtractor={(row) =>
							row.type === "header" ? `header:${row.title}` : row.token
						}
						contentClass="gap-3"
						estimatedItemSize={140}
					>
						{(row) => {
							const item = row();
							return item.type === "header" ? (
								<Text class="pt-1 text-sm font-medium">{item.title}</Text>
							) : (
								<TokenCard
									tokens={props.tokens}
									issues={issues}
									token={item.token}
									kind={item.kind}
									onChange={change}
								/>
							);
						}}
					</List>
				)
			}
		</View>
	);
}
