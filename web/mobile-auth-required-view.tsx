import {
	type Accessor,
	keyboardFrame,
	safeArea,
	signal,
	Text,
	token,
	View,
} from "nsh";
import { Collapsible } from "nsh/base";

import { webInputFontSize } from "@shared/web-font-scale";
import { t } from "../app/shell/i18n";
import { Button } from "../app/ui/button";
import { Icon } from "../app/ui/icon";
import { Input } from "../app/ui/input";
import { collapsibleRevealProps } from "../app/ui/motion";
import { styleVar } from "../app/ui/theme-style";
import { MobileViewport } from "./mobile-viewport";

/**
 * Shown when no valid paired device token is present in browser storage.
 * Aligned with React's unauthenticated Remote WebUI card, with optional
 * manual token entry for direct pairing.
 */
export function MobileAuthRequiredView(props: {
	error?: Accessor<string | null>;
	onSubmitToken: (token: string) => void;
}) {
	const viewport = MobileViewport();
	const tokenDraft = signal("");
	const showTokenInput = signal(false);

	const submit = () => {
		const trimmed = tokenDraft().trim();
		if (!trimmed) return;
		props.onSubmitToken(trimmed);
	};

	const bottomInset = () =>
		viewport.managed()
			? Math.max(24, safeArea().bottom + 16)
			: Math.max(24, safeArea().bottom + 16) + keyboardFrame().height;

	return (
		<View
			testID="mobile-auth-required"
			class="flex-1 items-center justify-center bg-background p-6"
			style={{
				paddingTop: Math.max(24, viewport.safeAreaTop() + 16),
				paddingBottom: bottomInset(),
				paddingLeft: Math.max(24, safeArea().left + 16),
				paddingRight: Math.max(24, safeArea().right + 16),
			}}
		>
			<View
				class="w-full max-w-sm rounded-2xl border border-border bg-card p-6"
				style={{ boxShadow: styleVar("pilo-shadow-sm") }}
			>
				<View class="gap-4">
					<View class="items-center">
						<Icon name="WifiOff" size={24} color={token("muted-foreground")} />
						<Text class="mt-4 text-center font-sans text-lg text-(length:--pilo-ui-text-lg) leading-snug font-semibold text-foreground">
							Pilo Remote
						</Text>
						<Text class="mt-2 text-center font-sans text-sm text-(length:--pilo-ui-text-sm) leading-normal text-muted-foreground">
							{() => props.error?.() || t("settings.remotePairRequired")}
						</Text>
					</View>

					<Button
						testID="mobile-toggle-token-input"
						variant="ghost"
						size="sm"
						class="min-h-9 w-full"
						onPress={() => showTokenInput.update((v) => !v)}
					>
						<Text class="font-sans text-xs text-(length:--pilo-ui-text-xs) leading-snug text-muted-foreground">
							{() =>
								showTokenInput()
									? t("common.cancel")
									: t("settings.remoteManualTokenToggle")
							}
						</Text>
					</Button>
				</View>

				<Collapsible
					open={showTokenInput()}
					{...collapsibleRevealProps()}
					content={
						<View class="gap-2 pt-3">
							<Input
								testID="mobile-token-input"
								value={tokenDraft()}
								placeholder={t("settings.remoteManualTokenPlaceholder")}
								autoCorrect={false}
								autoCapitalize="none"
								class="min-h-11"
								style={{
									fontSize: webInputFontSize(token("pilo-ui-text-sm")),
								}}
								onChange={(event) => tokenDraft.set(event.value)}
								onSubmit={submit}
							/>
							<Button
								testID="mobile-token-submit"
								variant="default"
								class="min-h-11 w-full"
								disabled={!tokenDraft().trim()}
								onPress={submit}
							>
								<Text class="font-sans text-sm text-(length:--pilo-ui-text-sm) leading-tight font-medium text-primary-foreground">
									{() => t("common.confirm")}
								</Text>
							</Button>
						</View>
					}
				/>
			</View>
		</View>
	);
}
