import assert from "node:assert/strict";
import test from "node:test";

import enUS from "../../src/i18n/resources/en-US.ts";
import zhCN from "../../src/i18n/resources/zh-CN.ts";

test("Chinese settings menus and core labels stay within two to four characters", () => {
	const labels = {
		preferences: zhCN.settings.preferences,
		theme: zhCN.settings.theme,
		font: zhCN.settings.font,
		notifications: zhCN.settings.notifications,
		shortcuts: zhCN.settings.shortcuts,
		connections: zhCN.settings.connections,
		nextPrompt: zhCN.settings.nextPrompt,
		promptEnhancement: zhCN.settings.promptEnhancement,
		cacheKeepAlive: zhCN.settings.cacheKeepAlive,
		sessionNaming: zhCN.settings.sessionNaming,
		about: zhCN.settings.about,
		sendShortcut: zhCN.settings.sendShortcut,
		collapseLongMessages: zhCN.settings.collapseLongMessages,
		collapseWork: zhCN.settings.collapseWork,
		developerMode: zhCN.settings.developerMode,
		themeCustomCss: zhCN.settings.themeCustomCss,
		saveTheme: zhCN.settings.saveTheme,
		updateTheme: zhCN.settings.updateTheme,
		cacheKeepAliveTtlLabel: zhCN.settings.cacheKeepAliveTtlLabel,
		cacheKeepAliveDurationLabel: zhCN.settings.cacheKeepAliveDurationLabel,
		startupAndTray: zhCN.desktop.startupAndTray,
		autostart: zhCN.desktop.autostart,
		autostartDisabled: zhCN.desktop.autostartDisabled,
		autostartWindow: zhCN.desktop.autostartWindow,
		autostartTray: zhCN.desktop.autostartTray,
	};

	for (const [key, value] of Object.entries(labels)) {
		assert.ok(Array.from(value).length >= 2, key);
		assert.ok(Array.from(value).length <= 4, key);
	}
	assert.equal(zhCN.settings.cacheKeepAlive, "缓存保活");
});

test("Chinese settings descriptions stay within twenty fixed characters except approved explanations", () => {
	const sections = {
		desktop: zhCN.desktop,
		settings: zhCN.settings,
		connection: zhCN.connection,
		shortcuts: zhCN.shortcuts,
		about: zhCN.about,
	};

	for (const [section, entries] of Object.entries(sections)) {
		for (const [key, value] of Object.entries(entries)) {
			// Remote access is a separate entry; dynamic user data is not truncated.
			if (key.startsWith("remote")) continue;
			// Approved explanations keep behavior, costs and privacy together.
			if (
				section === "settings" &&
				(key === "nextPromptDescription" || key === "cacheKeepAliveDescription")
			)
				continue;
			if (
				!/(Description|Hint|Failed|Unavailable|WindowEnding|PreviewReadingText|fontSizeRange)$/.test(
					key,
				)
			)
				continue;
			const fixedCopy = value.replace(/\{\{\w+\}\}/g, "");
			assert.ok(
				Array.from(fixedCopy).length <= 20,
				`${section}.${key}: ${value}`,
			);
		}
	}
});

test("short settings copy retains costs, privacy, deletion scope and dynamic values", () => {
	assert.match(zhCN.settings.nextPromptDescription, /回复后推荐下一条消息/);
	assert.match(zhCN.settings.nextPromptDescription, /按需采用/);
	assert.match(zhCN.settings.nextPromptDescription, /额外调用模型/);
	assert.match(zhCN.settings.nextPromptDescription, /发送部分对话/);
	assert.match(zhCN.settings.nextPromptDescription, /同一连接共用设置/);
	assert.match(zhCN.settings.cacheKeepAliveDescription, /空闲时自动刷新缓存/);
	assert.match(zhCN.settings.cacheKeepAliveDescription, /切换会话后继续/);
	assert.match(zhCN.settings.cacheKeepAliveDescription, /费用/);
	assert.match(zhCN.settings.cacheKeepAliveDescription, /达到设定时长/);
	assert.match(
		zhCN.settings.cacheKeepAliveDescription,
		/失败、超时、未命中即停止/,
	);
	assert.match(enUS.settings.cacheKeepAliveDescription, /API charges/);
	assert.match(
		enUS.settings.cacheKeepAliveDescription,
		/failure, timeout or a cache miss/,
	);
	assert.match(zhCN.connection.removeDescription, /连接及项目记录/);
	assert.match(zhCN.connection.removeDescription, /保留项目文件/);
	assert.match(zhCN.connection.sshCredentialsDeleted, /删除.*登录信息/);

	const templates = [
		[zhCN.settings.deleteTheme, enUS.settings.deleteTheme],
		[zhCN.settings.fontSizeRange, enUS.settings.fontSizeRange],
		[
			zhCN.settings.updateDialogDescription,
			enUS.settings.updateDialogDescription,
		],
		[zhCN.settings.cacheKeepAliveSummary, enUS.settings.cacheKeepAliveSummary],
		[zhCN.settings.cacheKeepAliveUsage, enUS.settings.cacheKeepAliveUsage],
		[zhCN.shortcuts.conflictDescription, enUS.shortcuts.conflictDescription],
		[
			zhCN.shortcuts.defaultOccupiedDescription,
			enUS.shortcuts.defaultOccupiedDescription,
		],
	];
	for (const [translated, original] of templates) {
		assert.deepEqual(
			translated.match(/\{\{\w+\}\}/g)?.toSorted(),
			original.match(/\{\{\w+\}\}/g)?.toSorted(),
		);
	}
});
