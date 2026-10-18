/**
 * Top bar: π mark, session title (renamable in place), a "No workspace" badge on
 * chats without a workspace, and New chat / New chat without workspace / History /
 * Settings icon buttons.
 */
import type { ChatRequest, SessionState, SessionStats } from "../../src/protocol";
import { h, iconButton } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";

type Post = (request: ChatRequest) => void;

export class Header {
	readonly element: HTMLElement;
	#title = h("div", { className: "session-title" }, "New chat");
	#rename: HTMLButtonElement;
	#input = h("input", { type: "text", className: "title-input", ariaLabel: "Session name", hidden: true });
	#sessionTitle = "New chat";
	#history: HTMLButtonElement;
	#back: HTMLButtonElement;
	#historyOpen = false;
	/** A session is open (omp answered `get_state`), so it can be renamed. */
	#hasSession = false;
	#noWorkspace = h(
		"span",
		{
			className: "no-workspace-badge",
			hidden: true,
			dataset: { tooltip: "A chat without a workspace: omp runs in its own folder, not in this project" },
		},
		icon("globe"),
		"No workspace",
	);

	constructor(
		private readonly post: Post,
		onHistory: () => void,
	) {
		this.#history = iconButton("history", "History", onHistory);
		this.#back = iconButton("back", "Back to chat", onHistory);
		this.#back.hidden = true;
		this.#rename = iconButton("pencil", "Rename chat", () => this.#startRename());
		this.#rename.classList.add("title-rename");
		this.#title.addEventListener("dblclick", () => this.#startRename());
		this.#input.addEventListener("keydown", event => {
			if (event.isComposing) return;
			if (event.key === "Enter") {
				event.preventDefault();
				this.#finishRename(true);
			} else if (event.key === "Escape") {
				event.preventDefault();
				this.#finishRename(false);
			}
		});
		this.#input.addEventListener("blur", () => this.#finishRename(true));
		this.element = h(
			"header",
			{ className: "header" },
			h("span", { className: "brand", ariaHidden: "true" }, "π"),
			this.#title,
			this.#input,
			this.#rename,
			this.#noWorkspace,
			h(
				"div",
				{ className: "header-actions" },
				iconButton("plus", "New chat", () => post({ type: "newSession" })),
				iconButton("plusGlobe", "New chat without workspace (general tasks, not this project)", () =>
					post({ type: "newSession", noWorkspace: true }),
				),
				this.#history,
				this.#back,
				iconButton("settings", "Settings", () => post({ type: "openSettings" })),
			),
		);
		this.#render();
	}

	setState(
		state: SessionState,
		_stats: SessionStats | undefined,
		title: string | undefined,
		noWorkspace: boolean,
	): void {
		this.#hasSession = true;
		this.#sessionTitle = title || state.sessionName || "New chat";
		this.#noWorkspace.dataset.on = String(noWorkspace);
		this.#render();
	}

	/** While the history panel is open the bar reads "History" and offers Back instead of History. */
	setHistoryMode(open: boolean): void {
		this.#historyOpen = open;
		this.#history.hidden = open;
		this.#back.hidden = !open;
		if (open) this.#finishRename(false);
		this.#render();
	}

	#canRename(): boolean {
		return this.#hasSession && !this.#historyOpen;
	}

	#startRename(): void {
		if (!this.#canRename() || !this.#input.hidden) return;
		this.#input.value = this.#sessionTitle === "New chat" ? "" : this.#sessionTitle;
		this.#input.placeholder = "Name this chat";
		this.#input.hidden = false;
		this.#title.hidden = true;
		this.#rename.hidden = true;
		this.#input.focus();
		this.#input.select();
	}

	/** Enter or leaving the field renames (an empty or unchanged name does nothing); Escape cancels. */
	#finishRename(save: boolean): void {
		if (this.#input.hidden) return;
		this.#input.hidden = true;
		const name = this.#input.value.trim();
		if (save && name && name !== this.#sessionTitle) {
			// Shown at once; omp's refreshed state follows.
			this.#sessionTitle = name;
			this.post({ type: "renameSession", name });
		}
		this.#render();
	}

	#render(): void {
		const text = this.#historyOpen ? "History" : this.#sessionTitle;
		this.#title.textContent = text;
		this.#title.hidden = !this.#input.hidden;
		this.#rename.hidden = !this.#canRename() || !this.#input.hidden;
		this.#noWorkspace.hidden = this.#noWorkspace.dataset.on !== "true" || this.#historyOpen || !this.#input.hidden;
		setTooltip(this.#title, this.#canRename() ? `${text}\nDouble-click to rename` : text);
	}
}
