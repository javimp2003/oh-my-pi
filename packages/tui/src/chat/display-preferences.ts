/** Process-wide display preferences applied by the host settings hooks. */
export interface ChatTranscriptDisplayPreferences {
	hideToolActivity: boolean;
	readToolResultPreview: boolean;
	showImages: boolean;
	cacheMissMarker: boolean;
	showTokenUsage: boolean;
	showTurnTime: boolean;
	/** Settled tool results show only their header row until expanded. */
	compactToolOutput: boolean;
	/** Rule between a turn's internal work (tools, thinking) and its final answer. */
	answerDivider: boolean;
}

/** Current transcript display preferences. */
export const chatTranscriptDisplayPreferences: ChatTranscriptDisplayPreferences = {
	hideToolActivity: false,
	readToolResultPreview: false,
	showImages: true,
	cacheMissMarker: false,
	showTokenUsage: false,
	showTurnTime: false,
	compactToolOutput: false,
	answerDivider: false,
};

/** Apply host display preferences without pulling settings into the renderer. */
export function setChatTranscriptDisplayPreferences(preferences: Partial<ChatTranscriptDisplayPreferences>): void {
	Object.assign(chatTranscriptDisplayPreferences, preferences);
}
