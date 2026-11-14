import type { Component } from "../tui";
import { truncateToWidth, visibleWidth } from "../utils";
import { theme } from "../theme";
import { hasTranscriptActions, runTranscriptAction } from "./transcript-actions";

/** ANSI dock action: remains reachable when the answer retires into scrollback. */
export class ResponseCopyButton implements Component {
	#paintedText: string | undefined;
	#hitWidth = 0;
	constructor(private readonly getText: () => string | undefined) {}

	render(width: number): readonly string[] {
		const text = this.getText();
		this.#paintedText = hasTranscriptActions() && text?.trim() ? text : undefined;
		this.#hitWidth = 0;
		if (this.#paintedText === undefined || width <= 0) return [];
		const button = "[ Copy response ]";
		this.#hitWidth = Math.min(width, visibleWidth(button));
		return [truncateToWidth(`${theme.fg("accent", button)} ${theme.fg("dim", "/copy answer")}`, width)];
	}

	handleViewportClick(row: number, col: number): boolean {
		if (row !== 0 || col < 0 || col >= this.#hitWidth || this.#paintedText === undefined) return false;
		return runTranscriptAction({ act: "copy", text: this.#paintedText });
	}
}
