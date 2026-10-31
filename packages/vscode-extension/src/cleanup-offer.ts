/** Context usage (percent of the model's window) at which the chat offers Clean up (`/shake`). */
export const CLEANUP_OFFER_PERCENT = 30;

/**
 * When to offer Clean up: once each time a session's context crosses
 * {@link CLEANUP_OFFER_PERCENT}. Answering the offer (running it or "not now")
 * silences it for that session until its usage drops below the threshold again
 * (after a clean up, compaction or handoff), so the next crossing offers it anew.
 */
export class CleanupOfferTracker {
	/** Sessions whose offer was answered while they stayed at or above the threshold. */
	#answered = new Set<string>();

	/** Whether to offer Clean up for `session` at `percent` of its context window. */
	shouldOffer(session: string, percent: number): boolean {
		if (percent < CLEANUP_OFFER_PERCENT) {
			this.#answered.delete(session);
			return false;
		}
		return !this.#answered.has(session);
	}

	answer(session: string): void {
		this.#answered.add(session);
	}
}
