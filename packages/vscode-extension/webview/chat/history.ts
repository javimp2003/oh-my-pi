/**
 * Session history overlay: a searchable list of the workspace's sessions
 * covering the transcript. Opening it asks the host for `listSessions`;
 * picking a row posts `openSession`.
 */
import type { ChatRequest, SessionListItem } from "../../src/protocol";
import { h } from "../dom";

type Post = (request: ChatRequest) => void;

export class HistoryPanel {
	readonly element: HTMLElement;
	#search = h("input", {
		type: "text",
		className: "history-search",
		placeholder: "Search chats",
		ariaLabel: "Search chats",
	});
	#list = h("div", { className: "history-list", role: "listbox" });
	/** Undefined until the host answers `listSessions`. */
	#sessions: SessionListItem[] | undefined;
	#matches: SessionListItem[] = [];
	#selected = 0;

	constructor(
		private readonly post: Post,
		private readonly onModeChange: (open: boolean) => void,
	) {
		this.element = h("div", { className: "history-panel", hidden: true }, this.#search, this.#list);
		this.#search.addEventListener("input", () => {
			this.#selected = 0;
			this.#render();
		});
		this.#search.addEventListener("keydown", event => this.#onKeyDown(event));
	}

	get isOpen(): boolean {
		return !this.element.hidden;
	}

	toggle(): void {
		if (this.isOpen) {
			this.close();
			return;
		}
		this.element.hidden = false;
		this.#sessions = undefined;
		this.#search.value = "";
		this.#selected = 0;
		this.#render();
		this.onModeChange(true);
		this.post({ type: "listSessions" });
		this.#search.focus();
	}

	close(): void {
		if (!this.isOpen) return;
		this.element.hidden = true;
		this.onModeChange(false);
	}

	setSessions(items: SessionListItem[]): void {
		this.#sessions = items;
		this.#selected = Math.max(
			0,
			items.findIndex(item => item.active),
		);
		this.#render();
	}

	#render(): void {
		if (this.#sessions === undefined) {
			this.#matches = [];
			this.#list.replaceChildren(h("div", { className: "history-empty" }, "Loading…"));
			return;
		}
		const needle = this.#search.value.trim().toLowerCase();
		this.#matches = this.#sessions.filter(item =>
			`${item.label} ${item.detail ?? ""}`.toLowerCase().includes(needle),
		);
		if (this.#matches.length === 0) {
			const text = this.#sessions.length === 0 ? "No chats yet" : "No matches";
			this.#list.replaceChildren(h("div", { className: "history-empty" }, text));
			return;
		}
		this.#selected = Math.min(this.#selected, this.#matches.length - 1);
		this.#list.replaceChildren(
			...this.#matches.map((item, index) => {
				const row = h(
					"div",
					{
						className: `history-row${item.active ? " active" : ""}`,
						role: "option",
						ariaSelected: String(index === this.#selected),
						dataset: { tooltip: item.path },
					},
					h(
						"div",
						{ className: "history-line" },
						item.active ? h("span", { className: "history-active-dot" }) : null,
						h("span", { className: "history-label" }, item.label),
						h("span", { className: "history-age" }, item.age),
					),
					item.detail ? h("div", { className: "history-detail" }, item.detail) : null,
				);
				row.addEventListener("mousedown", event => event.preventDefault());
				row.addEventListener("click", () => this.#open(item));
				return row;
			}),
		);
		this.#list.children[this.#selected]?.scrollIntoView({ block: "nearest" });
	}

	#open(item: SessionListItem): void {
		this.close();
		this.post({ type: "openSession", path: item.path });
	}

	#onKeyDown(event: KeyboardEvent): void {
		if (event.isComposing) return;
		switch (event.key) {
			case "ArrowDown":
			case "ArrowUp": {
				event.preventDefault();
				const count = this.#matches.length;
				if (count === 0) return;
				this.#selected = (this.#selected + (event.key === "ArrowDown" ? 1 : -1) + count) % count;
				this.#render();
				return;
			}
			case "Enter": {
				event.preventDefault();
				const item = this.#matches[this.#selected];
				if (item) this.#open(item);
				return;
			}
			case "Escape":
				event.preventDefault();
				this.close();
				return;
		}
	}
}
