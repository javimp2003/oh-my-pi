/** Top bar: π mark, session title, and New chat / History / Settings icon buttons. */
import type { ChatRequest, SessionState, SessionStats } from "../../src/protocol";
import { h, iconButton } from "../dom";
import { setTooltip } from "../tooltip";

type Post = (request: ChatRequest) => void;

export class Header {
	readonly element: HTMLElement;
	#title = h("div", { className: "session-title" }, "New chat");
	#sessionTitle = "New chat";
	#history: HTMLButtonElement;
	#back: HTMLButtonElement;
	#historyOpen = false;

	constructor(post: Post, onHistory: () => void) {
		this.#history = iconButton("history", "History", onHistory);
		this.#back = iconButton("back", "Back to chat", onHistory);
		this.#back.hidden = true;
		this.element = h(
			"header",
			{ className: "header" },
			h("span", { className: "brand", ariaHidden: "true" }, "π"),
			this.#title,
			h(
				"div",
				{ className: "header-actions" },
				iconButton("plus", "New chat", () => post({ type: "newSession" })),
				this.#history,
				this.#back,
				iconButton("settings", "Settings", () => post({ type: "openSettings" })),
			),
		);
		this.#render();
	}

	setState(state: SessionState, _stats: SessionStats | undefined, title: string | undefined): void {
		this.#sessionTitle = title || state.sessionName || "New chat";
		this.#render();
	}

	/** While the history panel is open the bar reads "History" and offers Back instead of History. */
	setHistoryMode(open: boolean): void {
		this.#historyOpen = open;
		this.#history.hidden = open;
		this.#back.hidden = !open;
		this.#render();
	}

	#render(): void {
		const text = this.#historyOpen ? "History" : this.#sessionTitle;
		this.#title.textContent = text;
		setTooltip(this.#title, text);
	}
}
