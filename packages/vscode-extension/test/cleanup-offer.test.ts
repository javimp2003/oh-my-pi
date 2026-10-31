import { describe, expect, it } from "bun:test";
import { CLEANUP_OFFER_PERCENT, CleanupOfferTracker } from "../src/cleanup-offer";

describe("Clean up offer", () => {
	it("offers from the threshold up, until answered", () => {
		const tracker = new CleanupOfferTracker();
		expect(tracker.shouldOffer("a", CLEANUP_OFFER_PERCENT - 1)).toBe(false);
		expect(tracker.shouldOffer("a", CLEANUP_OFFER_PERCENT)).toBe(true);
		tracker.answer("a");
		expect(tracker.shouldOffer("a", 80)).toBe(false);
	});

	it("offers again after the context dropped below the threshold and crossed it anew", () => {
		const tracker = new CleanupOfferTracker();
		tracker.answer("a");
		expect(tracker.shouldOffer("a", 45)).toBe(false);
		expect(tracker.shouldOffer("a", 12)).toBe(false);
		expect(tracker.shouldOffer("a", 31)).toBe(true);
	});

	it("keeps each session's answer separate", () => {
		const tracker = new CleanupOfferTracker();
		tracker.answer("a");
		expect(tracker.shouldOffer("a", 50)).toBe(false);
		expect(tracker.shouldOffer("b", 50)).toBe(true);
	});
});
