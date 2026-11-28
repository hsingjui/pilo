import assert from "node:assert/strict";
import test from "node:test";

import {
	createWebChatScrollFollower,
	type WebChatScrollMetrics,
} from "@shared/chat/web-chat-scroll";

function metrics(
	scrollTop: number,
	scrollHeight: number,
	clientHeight = 600,
	contentHeight = scrollHeight,
): WebChatScrollMetrics {
	return { scrollTop, scrollHeight, clientHeight, contentHeight };
}

test("resumes following when user scrolls back to bottom while streaming changes scrollHeight", () => {
	let now = 0;
	const follower = createWebChatScrollFollower(metrics(1400, 2000), true);

	// User swipes down (scrolls up to read older messages).
	follower.onTouchStart(200);
	follower.onDragChange(true, metrics(1400, 2000));
	follower.onTouchMove(260, metrics(1300, 2000));
	follower.onScroll(metrics(1000, 2000), now);
	follower.onTouchEnd(metrics(1000, 2000));
	follower.onDragChange(false, metrics(1000, 2000));
	assert.equal(follower.isFollowing(), false);

	// Streaming grows content while user is reading: must stay put.
	now += 50;
	assert.equal(follower.onResize(metrics(1000, 2120), now).scrollTop, null);
	assert.equal(follower.isFollowing(), false);

	// User flicks back toward bottom; finger lifts mid-flight before reaching end.
	now += 50;
	follower.onTouchStart(400);
	follower.onDragChange(true, metrics(1000, 2120));
	follower.onTouchMove(250, metrics(1200, 2120));
	follower.onTouchEnd(metrics(1200, 2120));
	follower.onDragChange(false, metrics(1200, 2120));
	assert.equal(follower.isFollowing(), false);

	// Momentum scroll reaches bottom AT THE SAME TIME streaming grew scrollHeight
	// before ResizeObserver had a chance to update `end`.
	now += 32;
	follower.onScroll(metrics(1560, 2180), now);
	assert.equal(follower.isFollowing(), true);

	// Subsequent streaming resize keeps clamping to the new end.
	now += 50;
	assert.equal(follower.onResize(metrics(1560, 2240), now).scrollTop, 1640);
});

test("resumes following on scrollEnd after mobile momentum lands at bottom", () => {
	const follower = createWebChatScrollFollower(metrics(1000, 2000), false);

	// Finger flicks toward bottom; released while still away from end.
	follower.onTouchStart(400);
	follower.onDragChange(true, metrics(1000, 2000));
	follower.onTouchMove(200, metrics(1250, 2000));
	follower.onTouchEnd(metrics(1250, 2000));
	follower.onDragChange(false, metrics(1250, 2000));
	assert.equal(follower.isFollowing(), false);

	// Momentum finishes at bottom (even if scroll was coalesced with a resize).
	follower.onScrollEnd(metrics(1400, 2000));
	assert.equal(follower.isFollowing(), true);
	assert.equal(follower.onResize(metrics(1400, 2100), 100).scrollTop, 1500);
});

test("clicking scroll-to-latest keeps following across smooth scroll animation frames", () => {
	let now = 0;
	const follower = createWebChatScrollFollower(metrics(400, 2000), false);

	// User clicks scroll-to-latest button, kicking off a 300ms smooth scroll.
	follower.startScrollToEnd(metrics(400, 2000));
	assert.equal(follower.isFollowing(), true);

	// Early animation frames are still far from bottom — must NOT cancel following.
	now += 16;
	follower.onScroll(metrics(650, 2000), now);
	assert.equal(follower.isFollowing(), true);
	now += 16;
	follower.onScroll(metrics(1100, 2000), now);
	assert.equal(follower.isFollowing(), true);

	// Animation arrives at bottom.
	now += 16;
	follower.onScroll(metrics(1400, 2000), now);
	follower.onScrollEnd(metrics(1400, 2000));
	assert.equal(follower.isFollowing(), true);

	// Subsequent streaming follows automatically.
	now += 50;
	assert.equal(follower.onResize(metrics(1400, 2080), now).scrollTop, 1480);

	// User interrupting mid-animation with upward wheel takes control back.
	follower.startScrollToEnd(metrics(400, 2080));
	follower.onWheel(
		{ deltaX: 0, deltaY: -40, ctrlKey: false, shiftKey: false },
		metrics(700, 2080),
	);
	assert.equal(follower.isFollowing(), false);
});

test("pushes messages up when soft keyboard shrinks viewport while user is at bottom", () => {
	let now = 1000;
	// User is at the bottom of a 2000px list in a 600px viewport (scrollTop = 1400).
	const follower = createWebChatScrollFollower(metrics(1400, 2000, 600), true);

	// User taps composer textarea -> focusin triggers shrink intent.
	assert.equal(
		follower.onViewportShrinkIntent(metrics(1400, 2000, 600), now).scrollTop,
		null,
	);

	// Frame 1: keyboard shrinks viewport to 440px (new maxOffset = 1560).
	now += 50;
	assert.equal(
		follower.onResize(metrics(1400, 2000, 440), now).scrollTop,
		1560,
	);

	// Browser emits a stale/focus scroll event during keyboard animation:
	// pin window keeps following active and clamps to the bottom.
	now += 20;
	assert.equal(
		follower.onScroll(metrics(1400, 2000, 440), now).scrollTop,
		1560,
	);
	assert.equal(follower.isFollowing(), true);

	// Frame 2: keyboard finishes opening, viewport shrinks to 320px (new maxOffset = 1680).
	now += 100;
	assert.equal(
		follower.onResize(metrics(1560, 2000, 320), now).scrollTop,
		1680,
	);
	assert.equal(follower.isFollowing(), true);
});

test("does not force scroll to bottom on keyboard open when user is scrolled up reading history", () => {
	let now = 1000;
	const follower = createWebChatScrollFollower(metrics(500, 2000, 600), false);

	assert.equal(
		follower.onViewportShrinkIntent(metrics(500, 2000, 600), now).scrollTop,
		null,
	);
	now += 50;
	assert.equal(follower.onResize(metrics(500, 2000, 320), now).scrollTop, null);
	assert.equal(follower.isFollowing(), false);
});

test("preserves disclosure pause and resumes when disclosure collapses near bottom", () => {
	let now = 1000;
	const follower = createWebChatScrollFollower(
		metrics(1400, 2000, 600, 2000),
		true,
	);

	follower.pauseForDisclosure(metrics(1400, 2000, 600, 2000));
	assert.equal(follower.isFollowing(), false);

	// Expanding disclosure grows content below viewport without jumping to end.
	now += 16;
	assert.equal(
		follower.onResize(metrics(1400, 2300, 600, 2300), now).scrollTop,
		null,
	);
	assert.equal(follower.isFollowing(), false);

	// Collapsing disclosure shrinks spacer back while user is still at bottom -> resumes following.
	now += 100;
	assert.equal(
		follower.onResize(metrics(1400, 2000, 600, 2000), now).scrollTop,
		null,
	);
	assert.equal(follower.isFollowing(), true);
});

test("touch tap on a disclosure at bottom expands downward without jumping upward", () => {
	let now = 1000;
	const follower = createWebChatScrollFollower(
		metrics(1400, 2000, 600, 2000),
		true,
	);

	// Mobile browser tap order: touchstart -> pointerup (triggers onPress / pauseForDisclosure) -> touchend.
	follower.onTouchStart(520);
	follower.pauseForDisclosure(metrics(1400, 2000, 600, 2000));
	follower.onTouchEnd(metrics(1400, 2000, 600, 2000));
	assert.equal(follower.isFollowing(), false);

	// Collapsible reveal grows content across multiple frames: must expand downward in place.
	now += 16;
	assert.equal(
		follower.onResize(metrics(1400, 2060, 600, 2060), now).scrollTop,
		null,
	);
	now += 16;
	assert.equal(
		follower.onResize(metrics(1400, 2240, 600, 2240), now).scrollTop,
		null,
	);
	assert.equal(follower.isFollowing(), false);

	// User manually scrolls down to the new bottom -> following resumes.
	now += 50;
	follower.onTouchStart(450);
	follower.onDragChange(true, metrics(1400, 2240, 600, 2240));
	follower.onTouchMove(250, metrics(1640, 2240, 600, 2240));
	follower.onScroll(metrics(1640, 2240, 600, 2240), now);
	follower.onTouchEnd(metrics(1640, 2240, 600, 2240));
	follower.onDragChange(false, metrics(1640, 2240, 600, 2240));
	assert.equal(follower.isFollowing(), true);
});

test("scroll-to-latest catches up on scrollEnd if streaming grew content during smooth animation", () => {
	let now = 0;
	const follower = createWebChatScrollFollower(metrics(400, 2000), false);

	follower.startScrollToEnd(metrics(400, 2000));
	assert.equal(follower.isFollowing(), true);

	// Content grows while smooth scroll is targeting the old end (1400).
	now += 100;
	assert.equal(follower.onResize(metrics(900, 2260), now).scrollTop, null);

	// Smooth scroll finishes at the old target (1400), still 260px short of 1660.
	now += 150;
	follower.onScroll(metrics(1400, 2260), now);
	assert.equal(follower.onScrollEnd(metrics(1400, 2260)).scrollTop, 1660);
	assert.equal(follower.isFollowing(), true);
});

test("horizontal touch swipe ignores minor vertical drift and keeps following", () => {
	const follower = createWebChatScrollFollower(metrics(1400, 2000), true);

	// Swipe horizontally across a wide code block/table with a 4px downward drift.
	follower.onTouchStart(300, 200);
	follower.onTouchMove(304, metrics(1400, 2000), 120);
	follower.onTouchEnd(metrics(1400, 2000));

	assert.equal(follower.isFollowing(), true);
	assert.equal(follower.onResize(metrics(1400, 2100), 50).scrollTop, 1500);
});

test("minor touch jitter without dragging does not leave scrollingUp stuck", () => {
	let now = 1000;
	const follower = createWebChatScrollFollower(metrics(1400, 2000, 600), true);

	// Finger jitters 4px downward without starting a drag or scrolling the list.
	follower.onTouchStart(300, 100);
	follower.onTouchMove(304, metrics(1400, 2000, 600), 100);
	follower.onTouchEnd(metrics(1400, 2000, 600));

	// Subsequent soft keyboard open still lifts messages since scrollingUp cleared.
	now += 50;
	follower.onViewportShrinkIntent(metrics(1400, 2000, 600), now);
	now += 50;
	assert.equal(
		follower.onResize(metrics(1400, 2000, 320), now).scrollTop,
		1680,
	);
	assert.equal(follower.isFollowing(), true);
});

test("keeps messages above the keyboard when a drag ends at the bottom before scrollEnd", () => {
	const follower = createWebChatScrollFollower(metrics(1300, 2000), false);

	follower.onTouchStart(400, 100);
	follower.onDragChange(true, metrics(1300, 2000));
	follower.onTouchMove(250, metrics(1380, 2000), 100);
	follower.onScroll(metrics(1400, 2000), 1000);
	follower.onTouchMove(256, metrics(1400, 2000), 100);
	follower.onTouchEnd(metrics(1400, 2000));
	follower.onDragChange(false, metrics(1400, 2000));

	assert.equal(
		follower.onViewportShrinkIntent(metrics(1400, 2000), 1010).scrollTop,
		null,
	);
	assert.equal(follower.isFollowing(), true);
	assert.equal(
		follower.onViewportShrinkIntent(metrics(1400, 2000, 320), 1030, true)
			.scrollTop,
		1680,
	);
	assert.equal(
		follower.onResize(metrics(1680, 2000, 320), 1030).scrollTop,
		null,
	);
	follower.onScrollEnd(metrics(1680, 2000, 320));
	assert.equal(follower.isFollowing(), true);
});

test("recovers following if the final touch release is the first event to see the bottom", () => {
	const follower = createWebChatScrollFollower(metrics(1396, 2000), true);

	follower.onTouchStart(250, 100);
	follower.onDragChange(true, metrics(1396, 2000));
	follower.onTouchMove(256, metrics(1396, 2000), 100);
	follower.onDragChange(false, metrics(1396, 2000));
	follower.onTouchEnd(metrics(1400, 2000));

	assert.equal(follower.isFollowing(), true);
	assert.equal(
		follower.onResize(metrics(1400, 2000, 320), 1030).scrollTop,
		1680,
	);
});

test("does not repin on keyboard open after an upward drag away from the bottom", () => {
	const follower = createWebChatScrollFollower(metrics(1400, 2000), true);

	follower.onTouchStart(250, 100);
	follower.onDragChange(true, metrics(1400, 2000));
	follower.onTouchMove(256, metrics(1400, 2000), 100);
	follower.onScroll(metrics(1394, 2000), 1000);
	follower.onTouchEnd(metrics(1394, 2000));
	follower.onDragChange(false, metrics(1394, 2000));

	assert.equal(
		follower.onViewportShrinkIntent(metrics(1394, 2000), 1010).scrollTop,
		null,
	);
	assert.equal(
		follower.onViewportShrinkIntent(metrics(1394, 2000, 320), 1030, true)
			.scrollTop,
		null,
	);
	assert.equal(
		follower.onResize(metrics(1394, 2000, 320), 1030).scrollTop,
		null,
	);
	follower.onScrollEnd(metrics(1394, 2000, 320));
	assert.equal(follower.isFollowing(), false);
});
