/**
 * Top bar: π mark, session title (renamable in place), a skill-curation
 * indicator beside it (a spinner while omp reviews the skills the last task used,
 * then a button opening the skill updates it made), a "No workspace" badge on
 * chats without a workspace, and New chat / New chat without workspace / History /
 * Settings icon buttons.
 */
import type { ChatRequest, SessionState, SessionStats, SkillUpdate } from "../../src/protocol";
import { button, h, iconButton } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";
import { skillUpdateElement } from "./notices";

type Post = (request: ChatRequest) => void;
type CurationStatus = "idle" | "running" | "done";

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
	#curationStatus: CurationStatus = "idle";
	#curationRunning = h("span", {
		className: "curation-spinner",
		hidden: true,
		role: "status",
		ariaLabel: "Improving skills",
		dataset: { tooltip: "omp is reviewing the skills this task used" },
	});
	#curationCount = h("span", { className: "curation-count" });
	#curationDone = h(
		"button",
		{ type: "button", className: "curation-done", hidden: true, ariaExpanded: "false" },
		icon("pencil"),
		this.#curationCount,
	);
	#curationList = h("div", { className: "curation-list" });
	#curationPanel = h(
		"div",
		{ className: "curation-panel", hidden: true, role: "dialog", ariaLabel: "Skill updates" },
		h(
			"div",
			{ className: "curation-panel-head" },
			h("span", { className: "curation-panel-title" }, "Skill updates"),
			button("Dismiss", "secondary-button", () => {
				this.#closeCurationPanel();
				this.post({ type: "dismissSkillCuration" });
			}),
			iconButton("close", "Close", () => this.#closeCurationPanel()),
		),
		this.#curationList,
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
		this.#curationDone.addEventListener("click", () => {
			if (this.#curationPanel.hidden) this.#openCurationPanel();
			else this.#closeCurationPanel();
		});
		document.addEventListener("keydown", event => {
			if (event.key === "Escape" && !this.#curationPanel.hidden) this.#closeCurationPanel();
		});
		document.addEventListener("mousedown", event => {
			const target = event.target as Node | null;
			if (this.#curationPanel.hidden || !target) return;
			if (this.#curationPanel.contains(target) || this.#curationDone.contains(target)) return;
			this.#closeCurationPanel();
		});
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
			this.#curationRunning,
			this.#curationDone,
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
			this.#curationPanel,
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

	/** Skill self-improvement of the open session (host `skillCuration` update). */
	setCuration(status: CurationStatus, updates: SkillUpdate[]): void {
		this.#curationStatus = status;
		const count = new Set(updates.map(update => update.skill)).size;
		this.#curationCount.textContent = String(count);
		setTooltip(
			this.#curationDone,
			`omp updated ${count} skill${count === 1 ? "" : "s"} after the last task — click to see the changes`,
		);
		this.#curationList.replaceChildren(
			...updates.map(update =>
				skillUpdateElement(update, () => this.post({ type: "revertSkillUpdate", id: update.id })),
			),
		);
		if (status !== "done") this.#closeCurationPanel();
		this.#render();
	}

	#openCurationPanel(): void {
		this.#curationPanel.hidden = false;
		this.#curationDone.ariaExpanded = "true";
	}

	#closeCurationPanel(): void {
		this.#curationPanel.hidden = true;
		this.#curationDone.ariaExpanded = "false";
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
		const curationVisible = !this.#historyOpen && this.#input.hidden;
		this.#curationRunning.hidden = !curationVisible || this.#curationStatus !== "running";
		this.#curationDone.hidden = !curationVisible || this.#curationStatus !== "done";
		if (this.#curationDone.hidden) this.#closeCurationPanel();
		setTooltip(this.#title, this.#canRename() ? `${text}\nDouble-click to rename` : text);
	}
}
