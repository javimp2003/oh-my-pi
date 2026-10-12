/**
 * Session history overlay: a searchable list of the workspace's sessions
 * covering the transcript. Opening it asks the host for `listSessions`;
 * picking a row posts `openSession`, its pencil renames it in place
 * (`renameSession`). Sessions working in the window show a spinner, those that
 * finished unseen a green dot.
 */
import type { ChatRequest, SessionActivity, SessionListItem } from "../../src/protocol";
import { h, iconButton } from "../dom";
import { setTooltip } from "../tooltip";

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
	/** Path of the row whose name is being edited. */
	#editing: string | undefined;

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

	/** Running/finished marks changed somewhere in the window: update the listed rows. */
	setActivity(activity: Record<string, SessionActivity>): void {
		if (!this.#sessions) return;
		for (const item of this.#sessions) item.activity = activity[item.path];
		// Re-rendering would discard a name being typed; the next render shows the marks.
		if (this.isOpen && this.#editing === undefined) this.#render();
	}

	/**
	 * Spinner while the session runs, green dot once it finished unseen, accent dot for
	 * the open one; a fixed-width slot either way so every label lines up.
	 */
	#marker(item: SessionListItem): HTMLElement {
		const slot = h("span", { className: "history-marker" });
		if (item.activity === "running") {
			slot.append(h("span", { className: "history-activity running" }));
			setTooltip(slot, "Running");
		} else if (item.activity === "done") {
			slot.append(h("span", { className: "history-activity done" }));
			setTooltip(slot, "Finished while you were in another session");
		} else if (item.active) {
			slot.append(h("span", { className: "history-active-dot" }));
		}
		return slot;
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
		this.#list.replaceChildren(...this.#matches.map((item, index) => this.#row(item, index)));
		this.#list.children[this.#selected]?.scrollIntoView({ block: "nearest" });
		this.#list.querySelector<HTMLInputElement>(".history-rename")?.focus();
	}

	#row(item: SessionListItem, index: number): HTMLElement {
		const editing = item.path === this.#editing;
		const label = editing ? this.#renameInput(item) : h("span", { className: "history-label" }, item.label);
		const rename = iconButton("pencil", "Rename", event => {
			event.stopPropagation();
			this.#editing = item.path;
			this.#render();
		});
		rename.classList.add("history-rename-button");
		const row = h(
			"div",
			{
				className: `history-row${item.active ? " active" : ""}${editing ? " editing" : ""}`,
				role: "option",
				ariaSelected: String(index === this.#selected),
				dataset: { tooltip: item.path },
			},
			h(
				"div",
				{ className: "history-line" },
				this.#marker(item),
				label,
				editing ? null : h("span", { className: "history-age" }, item.age),
				editing ? null : rename,
			),
			item.detail && !editing ? h("div", { className: "history-detail" }, item.detail) : null,
		);
		// Keep focus in the search box, except when clicking into the rename field.
		row.addEventListener("mousedown", event => {
			if (!(event.target as Element).closest(".history-rename")) event.preventDefault();
		});
		row.addEventListener("click", () => {
			if (!editing) this.#open(item);
		});
		return row;
	}

	/** Inline name editor: Enter renames, Escape or leaving the field cancels. */
	#renameInput(item: SessionListItem): HTMLInputElement {
		const input = h("input", {
			type: "text",
			className: "history-rename",
			value: item.label,
			ariaLabel: "Session name",
		});
		const finish = (save: boolean) => {
			if (this.#editing !== item.path) return;
			this.#editing = undefined;
			const name = input.value.trim();
			if (save && name && name !== item.label) {
				// Shown at once; the host's refreshed list follows.
				item.label = name;
				this.post({ type: "renameSession", path: item.path, name });
			}
			this.#render();
			this.#search.focus();
		};
		input.addEventListener("keydown", event => {
			event.stopPropagation();
			if (event.isComposing) return;
			if (event.key === "Enter") {
				event.preventDefault();
				finish(true);
			} else if (event.key === "Escape") {
				event.preventDefault();
				finish(false);
			}
		});
		input.addEventListener("blur", () => finish(false));
		queueMicrotask(() => input.select());
		return input;
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
