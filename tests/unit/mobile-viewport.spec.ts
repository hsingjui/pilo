import assert from "node:assert/strict";
import test from "node:test";

import {
	computeMobileViewportLayout,
	resolveKeyboardBaselineHeight,
	resolveMobileComposerBottomPadding,
	resolveMobileSafeAreaBottom,
	resolveMobileSafeAreaTop,
	resolveMobileSheetMaxHeight,
} from "@shared/mobile-viewport";

test("computeMobileViewportLayout keeps default inset on desktop and steady full viewport", () => {
	assert.deepEqual(
		computeMobileViewportLayout({
			innerHeight: 900,
			viewportHeight: 900,
			offsetTop: 0,
			scale: 1,
		}),
		{
			override: false,
			top: 0,
			height: 900,
			keyboardOpen: false,
			offsetTop: 0,
			shouldResetScroll: false,
		},
	);
});

test("computeMobileViewportLayout locks #app to visualViewport on Android resizes-visual keyboard open", () => {
	assert.deepEqual(
		computeMobileViewportLayout({
			innerHeight: 800,
			viewportHeight: 480,
			offsetTop: 0,
			scale: 1,
		}),
		{
			override: true,
			top: 0,
			height: 480,
			keyboardOpen: true,
			offsetTop: 0,
			shouldResetScroll: false,
		},
	);
});

test("computeMobileViewportLayout stays steady across Android resizes-content race frames", () => {
	// Frame 1: visualViewport shrinks before layout viewport finishes reflow.
	const preReflow = computeMobileViewportLayout({
		innerHeight: 800,
		viewportHeight: 480,
		offsetTop: 0,
		scale: 1,
	});
	assert.equal(preReflow.override, true);
	assert.equal(preReflow.top, 0);
	assert.equal(preReflow.height, 480);

	// Frame 2: layout viewport catches up to 480px; returns cleanly to CSS inset: 0 at the same 480px height.
	const postReflow = computeMobileViewportLayout({
		innerHeight: 480,
		keyboardBaselineHeight: 800,
		viewportHeight: 480,
		offsetTop: 0,
		scale: 1,
	});
	assert.equal(postReflow.override, false);
	assert.equal(postReflow.height, 480);
	assert.equal(postReflow.keyboardOpen, true);
	assert.equal(postReflow.offsetTop, 0);
});

test("computeMobileViewportLayout prevents bottom overshoot and double-shrink on Android WebView open/close races", () => {
	// Dismiss race: visualViewport grows back to 800 before innerHeight grows from 480.
	// Must never set #app height > innerHeight (which inflates nsh safeArea().bottom by +320px).
	assert.deepEqual(
		computeMobileViewportLayout({
			innerHeight: 480,
			keyboardBaselineHeight: 800,
			viewportHeight: 800,
			offsetTop: 0,
			scale: 1,
		}),
		{
			override: false,
			top: 0,
			height: 480,
			keyboardOpen: true,
			offsetTop: 0,
			shouldResetScroll: false,
		},
	);

	// Open race: innerHeight shrinks to 480 before visualViewport shrinks from 800.
	assert.deepEqual(
		computeMobileViewportLayout({
			innerHeight: 480,
			keyboardBaselineHeight: 800,
			viewportHeight: 800,
			offsetTop: 0,
			scale: 1,
		}),
		{
			override: false,
			top: 0,
			height: 480,
			keyboardOpen: true,
			offsetTop: 0,
			shouldResetScroll: false,
		},
	);

	// Double-shrink glitch: layout already shrank to 480, and visualViewport transiently drops to 160.
	assert.deepEqual(
		computeMobileViewportLayout({
			innerHeight: 480,
			keyboardBaselineHeight: 800,
			viewportHeight: 160,
			offsetTop: 0,
			scale: 1,
		}),
		{
			override: false,
			top: 0,
			height: 480,
			keyboardOpen: true,
			offsetTop: 0,
			shouldResetScroll: false,
		},
	);

	// Dismiss race on iOS Safari: viewportHeight returns to 844 before offsetTop resets from 336.
	// Clamps top so top + height never exceeds innerHeight.
	assert.deepEqual(
		computeMobileViewportLayout({
			innerHeight: 844,
			keyboardBaselineHeight: 844,
			viewportHeight: 844,
			offsetTop: 336,
			scale: 1,
		}),
		{
			override: false,
			top: 0,
			height: 844,
			keyboardOpen: false,
			offsetTop: 0,
			shouldResetScroll: false,
		},
	);
});

test("resolveKeyboardBaselineHeight keeps full viewport reference across repeated keyboard cycles and updates on idle resizes", () => {
	// Initial full height.
	let baseline = resolveKeyboardBaselineHeight({
		previousBaseline: 0,
		innerHeight: 800,
		viewportHeight: 800,
		widthChanged: false,
		editableFocused: false,
		keyboardWasOpen: false,
	});
	assert.equal(baseline, 800);

	// Opening keyboard shrinks innerHeight simultaneously with visualViewport -> keeps 800.
	baseline = resolveKeyboardBaselineHeight({
		previousBaseline: baseline,
		innerHeight: 480,
		viewportHeight: 480,
		widthChanged: false,
		editableFocused: true,
		keyboardWasOpen: false,
	});
	assert.equal(baseline, 800);

	// Blur while keyboard is still open/closing -> keeps 800.
	baseline = resolveKeyboardBaselineHeight({
		previousBaseline: baseline,
		innerHeight: 480,
		viewportHeight: 800,
		widthChanged: false,
		editableFocused: false,
		keyboardWasOpen: true,
	});
	assert.equal(baseline, 800);

	// Keyboard finishes closing -> still 800.
	baseline = resolveKeyboardBaselineHeight({
		previousBaseline: baseline,
		innerHeight: 800,
		viewportHeight: 800,
		widthChanged: false,
		editableFocused: false,
		keyboardWasOpen: true,
	});
	assert.equal(baseline, 800);

	// Idle vertical window/split-screen resize -> updates baseline to 420.
	baseline = resolveKeyboardBaselineHeight({
		previousBaseline: baseline,
		innerHeight: 420,
		viewportHeight: 420,
		widthChanged: false,
		editableFocused: false,
		keyboardWasOpen: false,
	});
	assert.equal(baseline, 420);

	// Orientation / width change -> resets baseline.
	baseline = resolveKeyboardBaselineHeight({
		previousBaseline: baseline,
		innerHeight: 390,
		viewportHeight: 390,
		widthChanged: true,
		editableFocused: true,
		keyboardWasOpen: true,
	});
	assert.equal(baseline, 390);
});

test("computeMobileViewportLayout tracks iOS Safari resize/scroll in either order without double-lift", () => {
	// Order 1: resize arrives before focus scroll.
	assert.deepEqual(
		computeMobileViewportLayout({
			innerHeight: 844,
			viewportHeight: 508,
			offsetTop: 0,
			scale: 1,
		}),
		{
			override: true,
			top: 0,
			height: 508,
			keyboardOpen: true,
			offsetTop: 0,
			shouldResetScroll: false,
		},
	);

	// Order 2: focus scroll shifts visualViewport.offsetTop down to reveal the focused textarea.
	assert.deepEqual(
		computeMobileViewportLayout({
			innerHeight: 844,
			viewportHeight: 508,
			offsetTop: 336.4,
			scale: 1,
		}),
		{
			override: true,
			top: 336,
			height: 508,
			keyboardOpen: true,
			offsetTop: 336,
			shouldResetScroll: false,
		},
	);

	// Overscroll above top clamps offsetTop to 0.
	const overscroll = computeMobileViewportLayout({
		innerHeight: 844,
		viewportHeight: 508,
		offsetTop: -24,
		scale: 1,
	});
	assert.equal(overscroll.top, 0);
	assert.equal(overscroll.offsetTop, 0);
});

test("computeMobileViewportLayout resets stale iOS scrollY when keyboard dismisses", () => {
	assert.deepEqual(
		computeMobileViewportLayout({
			innerHeight: 844,
			viewportHeight: 844,
			offsetTop: 0,
			scale: 1,
			scrollY: 120,
		}),
		{
			override: false,
			top: 0,
			height: 844,
			keyboardOpen: false,
			offsetTop: 0,
			shouldResetScroll: true,
		},
	);
});

test("computeMobileViewportLayout backs off during pinch-zoom and distinguishes small toolbar shifts", () => {
	assert.equal(
		computeMobileViewportLayout({
			innerHeight: 844,
			viewportHeight: 422,
			offsetTop: 100,
			scale: 2,
		}).override,
		false,
	);

	// Small 44px address bar change keeps #app fitted but does not flag keyboardOpen.
	const toolbarShift = computeMobileViewportLayout({
		innerHeight: 844,
		viewportHeight: 800,
		offsetTop: 0,
		scale: 1,
	});
	assert.equal(toolbarShift.override, true);
	assert.equal(toolbarShift.height, 800);
	assert.equal(toolbarShift.keyboardOpen, false);
});

test("resolveMobileComposerBottomPadding ignores transient keyboardFrame when viewport sync is managed", () => {
	// Managed web viewport: never adds keyboardHeight even if nsh reports a transient non-zero value.
	assert.equal(
		resolveMobileComposerBottomPadding({
			managed: true,
			keyboardOpen: true,
			keyboardHeight: 320,
			safeAreaBottom: 34,
		}),
		8,
	);
	assert.equal(
		resolveMobileComposerBottomPadding({
			managed: true,
			keyboardOpen: false,
			keyboardHeight: 320,
			safeAreaBottom: 34,
		}),
		42,
	);
	assert.equal(
		resolveMobileComposerBottomPadding({
			managed: true,
			keyboardOpen: false,
			keyboardHeight: 0,
			safeAreaBottom: 0,
		}),
		16,
	);

	// Unmanaged fallback (native/headless): preserves keyboardFrame lifting.
	assert.equal(
		resolveMobileComposerBottomPadding({
			managed: false,
			keyboardOpen: false,
			keyboardHeight: 300,
			safeAreaBottom: 34,
		}),
		308,
	);
});

test("resolveMobileSafeAreaTop preserves PWA top inset when iOS offsets #app downward", () => {
	assert.equal(
		resolveMobileSafeAreaTop({
			safeAreaTop: 0,
			baselineTop: 59,
			offsetTop: 336,
		}),
		59,
	);
	assert.equal(
		resolveMobileSafeAreaTop({
			safeAreaTop: 0,
			baselineTop: 59,
			offsetTop: 0,
		}),
		0,
	);
	assert.equal(
		resolveMobileSafeAreaTop({
			safeAreaTop: 47,
			baselineTop: 0,
			offsetTop: 336,
		}),
		47,
	);
});

test("resolveMobileSafeAreaBottom strips transient overshoot spikes while preserving device bottom inset", () => {
	assert.equal(
		resolveMobileSafeAreaBottom({
			safeAreaBottom: 34,
			baselineBottom: 34,
			bottomOvershoot: 0,
			keyboardOpen: false,
		}),
		34,
	);
	// Android WebView overshoot: #app bottom exceeded innerHeight by 320px.
	assert.equal(
		resolveMobileSafeAreaBottom({
			safeAreaBottom: 320,
			baselineBottom: 0,
			bottomOvershoot: 320,
			keyboardOpen: false,
		}),
		0,
	);
	// iPhone overshoot preserves 34px Home Indicator without the +320px spike.
	assert.equal(
		resolveMobileSafeAreaBottom({
			safeAreaBottom: 354,
			baselineBottom: 34,
			bottomOvershoot: 320,
			keyboardOpen: false,
		}),
		34,
	);
	// Stale spike reported after rect settled back to innerHeight.
	assert.equal(
		resolveMobileSafeAreaBottom({
			safeAreaBottom: 320,
			baselineBottom: 0,
			bottomOvershoot: 0,
			keyboardOpen: false,
		}),
		0,
	);
});

test("resolveMobileSheetMaxHeight fits compact keyboard-reduced viewports without overflowing", () => {
	assert.equal(resolveMobileSheetMaxHeight(844), 717);
	assert.equal(resolveMobileSheetMaxHeight(480), 408);
	assert.equal(resolveMobileSheetMaxHeight(300), 284);
	assert.equal(resolveMobileSheetMaxHeight(0), 320);
});
