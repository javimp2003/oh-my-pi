import type { AssistantMessage } from "../../src/protocol";
import { contentText } from "../../src/message-text";

export type ResponseCopyState = "hidden" | "ready" | "copying" | "copied" | "failed";

/** Clipboard state belongs to the displayed answer, including across async updates. */
export class ResponseCopyAction {
	#text = "";
	#version = 0;
	#pending: number | undefined;
	state: ResponseCopyState = "hidden";
	constructor(
		private readonly writeText: (text: string) => Promise<void>,
		private readonly changed: () => void,
	) {}

	update(message: Pick<AssistantMessage, "content">, streaming: boolean): void {
		const text = streaming ? "" : contentText(message.content, "");
		if (text === this.#text) return;
		this.#text = text;
		this.#version++;
		this.state = text.trim() ? "ready" : "hidden";
		this.changed();
	}

	async copy(): Promise<void> {
		if (!this.#text.trim() || this.#pending === this.#version) return;
		const version = this.#version;
		this.#pending = version;
		this.state = "copying";
		this.changed();
		try {
			await this.writeText(this.#text);
			if (version === this.#version) this.state = "copied";
		} catch {
			if (version === this.#version) this.state = "failed";
		} finally {
			if (this.#pending === version) this.#pending = undefined;
			if (version === this.#version) this.changed();
		}
	}
}
