import { type Accessor, safeArea, signal, Text, token, View } from "nsh";

import { t } from "../app/shell/i18n";
import { Button } from "../app/ui/button";
import { Icon } from "../app/ui/icon";
import { Input } from "../app/ui/input";
import { styleVar } from "../app/ui/theme-style";
import { MOBILE_TEXT } from "./mobile-typography";

/**
 * Shown when no valid paired device token is present in browser storage.
 * Aligned with React's unauthenticated Remote WebUI card, with optional
 * manual token entry for direct pairing.
 */
export function MobileAuthRequiredView(props: {
	error?: Accessor<string | null>;
	onSubmitToken: (token: string) => void;
}) {
	const tokenDraft = signal("");
	const showTokenInput = signal(false);

	const submit = () => {
		const trimmed = tokenDraft().trim();
		if (!trimmed) return;
		props.onSubmitToken(trimmed);
	};

	return (
		<View
			testID="mobile-auth-required"
			class="flex-1 items-center justify-center bg-background p-6"
			style={{
				paddingTop: Math.max(24, safeArea().top + 16),
				paddingBottom: Math.max(24, safeArea().bottom + 16),
			}}
		>
			<View
				class="w-full max-w-sm gap-4 rounded-2xl border border-border bg-card p-6"
				style={{ boxShadow: styleVar("pilo-shadow-sm") }}
			>
				<View class="items-center">
					<Icon name="WifiOff" size={24} color={token("muted-foreground")} />
					<Text
						class="mt-4 text-center font-sans font-semibold text-foreground"
						style={MOBILE_TEXT.base}
					>
						Pilo Remote
					</Text>
					<Text
						class="mt-2 text-center font-sans text-muted-foreground"
						style={MOBILE_TEXT.smRelaxed}
					>
						{() => props.error?.() || t("settings.remotePairRequired")}
					</Text>
				</View>

				<Button
					testID="mobile-toggle-token-input"
					variant="outline"
					class="min-h-11 w-full"
					onPress={() => showTokenInput.update((v) => !v)}
				>
					<Text class="font-sans text-foreground" style={MOBILE_TEXT.sm}>
						{() => (showTokenInput() ? t("common.cancel") : "Device Token")}
					</Text>
				</Button>

				{() =>
					showTokenInput() ? (
						<View class="gap-2">
							<Input
								testID="mobile-token-input"
								value={tokenDraft()}
								placeholder="Device token..."
								autoCorrect={false}
								autoCapitalize="none"
								class="min-h-11"
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
								<Text
									class="font-sans font-medium text-primary-foreground"
									style={MOBILE_TEXT.sm}
								>
									{() => t("common.confirm")}
								</Text>
							</Button>
						</View>
					) : null
				}
			</View>
		</View>
	);
}
