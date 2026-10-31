/**
 * Delegate mode button with its subagent panel. Without subagents to show the
 * button toggles delegate mode; once the current task has subagents it opens a
 * popover listing each one (status, task, current step, progress, estimated
 * time left, usage), the delegate mode switch, and "Hurry up", which asks every
 * running agent to wrap up.
 */
import type { ChatRequest, SubagentView } from "../../src/protocol";
import { h } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";
import { formatCost, formatTokens } from "./context-meter";

type Post = (request: ChatRequest) => void;

const STATUS_LABELS: Record<SubagentView["status"], string> = {
	pending: "Queued",
	running: "Running",
	completed: "Done",
	failed: "Failed",
	aborted: "Stopped",
};

function isActive(row: SubagentView): boolean {
	return row.status === "pending" || row.status === "running";
}

function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Run time: live for running rows, omp's reported time once finished. */
function elapsedMs(row: SubagentView, now: number): number {
	return isActive(row) ? Math.max(row.durationMs, now - row.startedAt) : row.durationMs || now - row.startedAt;
}

/** Time left extrapolated from the agent's completion self-estimate. */
function remainingMs(row: SubagentView, elapsed: number): number | undefined {
	const percent = row.completionPercent;
	if (!isActive(row) || percent === undefined || percent <= 0 || percent >= 100) return undefined;
	return (elapsed * (100 - percent)) / percent;
}

export class SubagentPanel {
	readonly element: HTMLElement;
	#trigger: HTMLButtonElement;
	#badge = h("span", { className: "subagent-badge", hidden: true });
	#popover = h("div", { className: "subagent-popover", role: "dialog", ariaLabel: "Subagents", hidden: true });
	#rows: SubagentView[] = [];
	#available = false;
	#modeOn = false;
	#ticker: number | undefined;

	constructor(
		private readonly post: Post,
		private readonly onToggleMode: () => void,
	) {
		this.#trigger = h(
			"button",
			{ type: "button", className: "icon-button delegate-toggle", ariaHasPopup: "dialog" },
			icon("bot"),
			this.#badge,
		);
		this.#trigger.addEventListener("click", () => {
			if (this.#rows.length > 0) this.#popover.hidden ? this.#open() : this.#close();
			else this.onToggleMode();
		});
		this.element = h("div", { className: "subagent-panel" }, this.#trigger, this.#popover);
		this.element.addEventListener("keydown", event => {
			if (event.key === "Escape" && !this.#popover.hidden) {
				event.preventDefault();
				event.stopPropagation();
				this.#close();
				this.#trigger.focus();
			}
		});
		document.addEventListener("mousedown", event => {
			if (!this.#popover.hidden && !this.element.contains(event.target as Node)) this.#close();
		});
		this.#renderTrigger();
	}

	/** Delegate mode availability and state; the button hides while omp cannot enter the mode and shows no subagents. */
	setMode(available: boolean, on: boolean): void {
		this.#available = available;
		this.#modeOn = on;
		this.#renderTrigger();
		if (!this.#popover.hidden) this.#render();
	}

	setSubagents(rows: SubagentView[]): void {
		this.#rows = rows;
		if (rows.length === 0) this.#close();
		this.#renderTrigger();
		if (!this.#popover.hidden) this.#render();
	}

	#renderTrigger(): void {
		this.#trigger.hidden = !this.#available && this.#rows.length === 0;
		this.#trigger.ariaPressed = String(this.#modeOn);
		const running = this.#rows.filter(isActive).length;
		this.#badge.hidden = this.#rows.length === 0;
		this.#badge.textContent = String(running || this.#rows.length);
		this.#badge.classList.toggle("active", running > 0);
		const mode = this.#modeOn ? "Delegate mode on" : "Delegate mode off";
		const title =
			this.#rows.length > 0
				? `${mode}. ${running > 0 ? `${running} subagent${running === 1 ? "" : "s"} running` : "Subagents finished"}: click to see them`
				: this.#modeOn
					? "Leave delegate mode"
					: "Delegate mode: MarIA Code splits the task and runs it through subagents it picks per slice";
		setTooltip(this.#trigger, title);
		this.#trigger.ariaLabel = title;
	}

	#open(): void {
		this.#popover.hidden = false;
		this.#trigger.ariaExpanded = "true";
		this.#render();
		this.#ticker ??= window.setInterval(() => this.#render(), 1000);
	}

	#close(): void {
		this.#popover.hidden = true;
		this.#trigger.ariaExpanded = "false";
		if (this.#ticker !== undefined) window.clearInterval(this.#ticker);
		this.#ticker = undefined;
	}

	#render(): void {
		const now = Date.now();
		const active = this.#rows.filter(isActive);
		const finished = this.#rows.length - active.length;
		const summary = [active.length > 0 && `${active.length} running`, finished > 0 && `${finished} finished`]
			.filter(Boolean)
			.join(" · ");

		const modeButton = h(
			"button",
			{ type: "button", className: "subagent-mode-button", disabled: !this.#available },
			this.#modeOn ? "Turn off" : "Turn on",
		);
		modeButton.addEventListener("click", () => this.onToggleMode());
		const mode = h(
			"div",
			{ className: "subagent-mode" },
			h("span", null, `Delegate mode: ${this.#modeOn ? "on" : "off"}`),
			modeButton,
		);

		const hurry = h(
			"button",
			{ type: "button", className: "subagent-hurry" },
			icon("zap"),
			h("span", null, "Hurry up"),
		);
		const pendingWrapUp = active.filter(row => !row.wrapUpRequested).length;
		hurry.disabled = pendingWrapUp === 0;
		setTooltip(
			hurry,
			active.length === 0
				? "No subagent is running."
				: pendingWrapUp === 0
					? "Every running agent was already asked to wrap up."
					: "Ask every running agent to wrap up: finish the step in progress, skip optional work, and report what is done. MarIA Code integrates instead of starting new work.",
		);
		hurry.addEventListener("click", () => {
			hurry.disabled = true;
			this.post({ type: "hurrySubagents" });
		});

		this.#popover.replaceChildren(
			h(
				"div",
				{ className: "subagent-header" },
				h("span", { className: "subagent-title" }, "Subagents"),
				h("span", { className: "subagent-summary" }, summary),
			),
			mode,
			h("div", { className: "subagent-list" }, ...this.#rows.map(row => this.#card(row, now))),
			h("div", { className: "subagent-actions" }, hurry),
		);
	}

	#card(row: SubagentView, now: number): HTMLElement {
		const elapsed = elapsedMs(row, now);
		const remaining = remainingMs(row, elapsed);
		const task = row.description ?? row.assignment?.split("\n").find(line => line.trim()) ?? "";

		const header = h(
			"div",
			{ className: "subagent-card-header" },
			h("span", { className: `subagent-dot ${row.status}` }),
			h("span", { className: "subagent-name" }, row.id),
			h("span", { className: "subagent-agent" }, row.agent),
			h("span", { className: "subagent-time" }, formatDuration(elapsed)),
		);
		setTooltip(header.children[1] as HTMLElement, `${STATUS_LABELS[row.status]} · ${row.agent}`);

		const lines: HTMLElement[] = [header];
		if (task) {
			const taskEl = h("div", { className: "subagent-task" }, task);
			if (row.assignment) setTooltip(taskEl, row.assignment);
			lines.push(taskEl);
		}
		if (row.activity) lines.push(h("div", { className: "subagent-activity" }, row.activity));
		if (row.retry) lines.push(h("div", { className: "subagent-retry" }, row.retry));

		// Progress: the agent's completion self-estimate, else the share of its request budget used.
		const percent =
			row.completionPercent ??
			(row.requestBudget ? Math.min(100, (row.requests / row.requestBudget) * 100) : undefined);
		if (percent !== undefined && isActive(row)) {
			const bar = h("div", { className: "subagent-bar" }, h("div", { className: "subagent-bar-fill" }));
			(bar.firstElementChild as HTMLElement).style.width = `${Math.round(percent)}%`;
			const label =
				row.completionPercent !== undefined
					? `~${Math.round(row.completionPercent)}% done${remaining !== undefined ? ` · ~${formatDuration(remaining)} left` : ""}`
					: `${row.requests} of ${row.requestBudget} requests used`;
			const progress = h("div", { className: "subagent-progress" }, bar, h("span", null, label));
			setTooltip(
				progress,
				row.completionPercent !== undefined
					? "The agent's own estimate of how complete its task is; time left is extrapolated from it."
					: "No completion estimate yet: requests used out of the soft budget the agent is held to.",
			);
			lines.push(progress);
		}

		const stats = [
			`${row.toolCount} tool${row.toolCount === 1 ? "" : "s"}`,
			row.requestBudget ? `${row.requests}/${row.requestBudget} req` : `${row.requests} req`,
			`${formatTokens(row.tokens)} tok`,
			formatCost(row.cost),
		];
		const statsEl = h("div", { className: "subagent-stats" }, stats.join(" · "));
		if (row.model) setTooltip(statsEl, row.model);
		lines.push(statsEl);
		if (row.wrapUpRequested && isActive(row))
			lines.push(h("div", { className: "subagent-flag" }, "Asked to wrap up"));
		if (!isActive(row)) {
			lines.push(h("div", { className: `subagent-final ${row.status}` }, STATUS_LABELS[row.status]));
		}
		return h("div", { className: `subagent-card ${row.status}` }, ...lines);
	}
}
