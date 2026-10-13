/**
 * The composer's microphone button. omp records and transcribes (the webview
 * cannot open the microphone itself); this tracks the capture through omp's
 * `dictation` updates: click to start, click again to stop and transcribe,
 * `cancel()` (Escape) to drop the recording. While recording it shows the
 * elapsed time.
 */
import type { ChatRequest } from "../../src/protocol";
import { h } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";

type Post = (request: ChatRequest) => void;

export type DictationState = "idle" | "starting" | "recording" | "transcribing";

const TOOLTIPS: Record<DictationState, string> = {
	idle: "Voice input",
	starting: "Opening the microphone… (click to cancel)",
	recording: "Stop and transcribe",
	transcribing: "Transcribing…",
};

export class DictationControl {
	readonly element: HTMLElement;
	#button: HTMLButtonElement;
	#timer = h("span", { className: "dictation-timer", hidden: true });
	#state: DictationState = "idle";
	#since = 0;
	#interval = 0;

	constructor(
		private readonly post: Post,
		private readonly onStateChange: (state: DictationState) => void,
	) {
		this.#button = h("button", { type: "button", className: "icon-button dictation-button" }, icon("mic"));
		this.#button.addEventListener("click", () => this.toggle());
		this.element = h("div", { className: "dictation" }, this.#timer, this.#button);
		this.#render();
	}

	get state(): DictationState {
		return this.#state;
	}

	/** Start recording, stop and transcribe, or give up on a microphone that is still opening. */
	toggle(): void {
		switch (this.#state) {
			case "idle":
				this.#set("starting");
				this.post({ type: "dictation", action: "start" });
				return;
			case "starting":
				this.cancel();
				return;
			case "recording":
				this.#set("transcribing");
				this.post({ type: "dictation", action: "stop" });
				return;
			case "transcribing":
				return;
		}
	}

	/** Drop the recording without transcribing it. */
	cancel(): void {
		if (this.#state === "idle" || this.#state === "transcribing") return;
		this.post({ type: "dictation", action: "cancel" });
		this.#set("idle");
	}

	/** omp reported a state change. */
	update(state: "recording" | "transcribing" | "idle"): void {
		// A late `recording` after the user gave up on a slow microphone stays cancelled.
		if (state === "recording" && this.#state === "idle") return;
		this.#set(state);
	}

	#set(state: DictationState): void {
		if (state === this.#state) return;
		const wasRecording = this.#state === "recording";
		this.#state = state;
		if (state === "recording" && !wasRecording) {
			this.#since = Date.now();
			this.#tick();
			this.#interval = window.setInterval(() => this.#tick(), 500);
		} else if (state !== "recording") {
			window.clearInterval(this.#interval);
		}
		this.#render();
		this.onStateChange(state);
	}

	#tick(): void {
		const seconds = Math.floor((Date.now() - this.#since) / 1000);
		this.#timer.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
	}

	#render(): void {
		this.element.dataset.state = this.#state;
		this.#timer.hidden = this.#state !== "recording";
		this.#button.disabled = this.#state === "transcribing";
		this.#button.ariaPressed = String(this.#state === "recording");
		this.#button.ariaLabel = TOOLTIPS[this.#state];
		setTooltip(this.#button, TOOLTIPS[this.#state]);
	}
}
