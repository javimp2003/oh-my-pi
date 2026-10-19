/**
 * Session history overlay: a searchable list of chats covering the transcript,
 * filtered by two tabs: the workspace's sessions or the chats without a
 * workspace (it opens on the open chat's group). Opening it asks the host for
 * `listSessions`; picking a row posts `openSession`, its pencil renames it in
 * place (`renameSession`), its trash deletes it after the host's confirmation
 * (`deleteSession`). Sessions working in the window show a spinner, those that
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
	#workspaceTab = h("button", { type: "button", className: "history-tab", role: "tab" });
	#noWorkspaceTab = h("button", { type: "button", className: "history-tab", role: "tab" });
	/** Undefined until the host answers `listSessions`. */
	#sessions: SessionListItem[] | undefined;
	#matches: SessionListItem[] = [];
	#selected = 0;
	/** Path of the row whose name is being edited. */
	#editing: string | undefined;
	/** The tab shown: chats without a workspace, else the workspace's. */
	#noWorkspace = false;
	/** Whether this opening picked its tab yet (from the first `sessions` answer). */
	#tabPicked = false;

	constructor(
		private readonly post: Post,
		private readonly onModeChange: (open: boolean) => void,
	) {
		const tabs = h(
			"div",
			{ className: "history-tabs", role: "tablist", ariaLabel: "Chats to show" },
			this.#workspaceTab,
			this.#noWorkspaceTab,
		);
		this.element = h("div", { className: "history-panel", hidden: true }, this.#search, tabs, this.#list);
		this.#search.addEventListener("input", () => {
			this.#selected = 0;
			this.#render();
		});
		this.#search.addEventListener("keydown", event => this.#onKeyDown(event));
		for (const [tab, noWorkspace] of [
			[this.#workspaceTab, false],
			[this.#noWorkspaceTab, true],
		] as const) {
			// Keep focus in the search box, as the rows do.
			tab.addEventListener("mousedown", event => event.preventDefault());
			tab.addEventListener("click", () => {
				if (this.#noWorkspace === noWorkspace) return;
				this.#noWorkspace = noWorkspace;
				this.#selected = 0;
				this.#render();
			});
		}
	}

	get isOpen(): boolean {
		return !this.element.hidden;
	}

	/** Put the caret in the panel's search box (Ctrl+F while the panel is open). */
	focusSearch(): void {
		this.#search.focus();
		this.#search.select();
	}

	toggle(): void {
		if (this.isOpen) {
			this.close();
			return;
		}
		this.element.hidden = false;
		this.#sessions = undefined;
		this.#tabPicked = false;
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
		if (!this.#tabPicked) {
			// Open on the open chat's group; on the other one when that group has no chats.
			this.#tabPicked = true;
			const active = items.find(item => item.active);
			this.#noWorkspace = active
				? active.noWorkspace
				: !items.some(item => !item.noWorkspace) && items.some(item => item.noWorkspace);
			this.#selected = Math.max(
				0,
				items.filter(item => item.noWorkspace === this.#noWorkspace).findIndex(item => item.active),
			);
		}
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
			this.#renderTabs(undefined);
			this.#list.replaceChildren(h("div", { className: "history-empty" }, "Loading…"));
			return;
		}
		const needle = this.#search.value.trim().toLowerCase();
		const found = this.#sessions.filter(item =>
			`${item.label} ${item.firstPrompt ?? ""} ${item.lastPrompt ?? ""}`.toLowerCase().includes(needle),
		);
		this.#renderTabs(found);
		this.#matches = found.filter(item => item.noWorkspace === this.#noWorkspace);
		if (this.#matches.length === 0) {
			const empty = this.#noWorkspace ? "No chats without a workspace yet" : "No chats in this workspace yet";
			const inGroup = this.#sessions.some(item => item.noWorkspace === this.#noWorkspace);
			this.#list.replaceChildren(h("div", { className: "history-empty" }, inGroup ? "No matches" : empty));
			return;
		}
		this.#selected = Math.min(this.#selected, this.#matches.length - 1);
		const rows = this.#matches.map((item, index) => this.#row(item, index));
		this.#list.replaceChildren(...rows);
		rows[this.#selected]?.scrollIntoView({ block: "nearest" });
		this.#list.querySelector<HTMLInputElement>(".history-rename")?.focus();
	}

	/** Tab labels with how many chats of each group match the search (no count while loading). */
	#renderTabs(found: SessionListItem[] | undefined): void {
		for (const [tab, noWorkspace, label] of [
			[this.#workspaceTab, false, "This workspace"],
			[this.#noWorkspaceTab, true, "No workspace"],
		] as const) {
			const count = found?.filter(item => item.noWorkspace === noWorkspace).length;
			tab.replaceChildren(
				label,
				count === undefined ? "" : h("span", { className: "history-tab-count" }, String(count)),
			);
			tab.ariaSelected = String(noWorkspace === this.#noWorkspace);
		}
	}

	#row(item: SessionListItem, index: number): HTMLElement {
		const editing = item.path === this.#editing;
		const label = editing ? this.#renameInput(item) : h("span", { className: "history-label" }, item.label);
		const rename = iconButton("pencil", "Rename", event => {
			event.stopPropagation();
			this.#editing = item.path;
			this.#render();
		});
		// The host asks for confirmation, then re-sends the list without it.
		const remove = iconButton("trash", "Delete", event => {
			event.stopPropagation();
			this.post({ type: "deleteSession", path: item.path, label: item.label });
		});
		rename.classList.add("history-row-button");
		remove.classList.add("history-row-button");
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
				editing ? null : remove,
			),
			editing ? null : this.#prompts(item),
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

	/** The session's first and latest prompts under its name; a single prompt says so. */
	#prompts(item: SessionListItem): HTMLElement | null {
		const line = (label: string, text: string) =>
			h(
				"div",
				{ className: "history-prompt" },
				h("span", { className: "history-prompt-label" }, label),
				h("span", { className: "history-prompt-text" }, text),
			);
		if (item.singlePrompt && item.firstPrompt) {
			return h("div", { className: "history-prompts" }, line("Only prompt", item.firstPrompt));
		}
		if (!item.firstPrompt && !item.lastPrompt) return null;
		return h(
			"div",
			{ className: "history-prompts" },
			item.firstPrompt ? line("First", item.firstPrompt) : null,
			item.lastPrompt ? line("Last", item.lastPrompt) : null,
		);
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
