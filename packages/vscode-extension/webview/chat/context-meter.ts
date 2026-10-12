/**
 * Composer context ring: a button showing how full the context window is.
 * Clicking it opens a popover with usage, session tokens and cost, and the
 * Compact / Clean up / Handoff commands.
 */
import type { ChatRequest, SessionState, SessionStats } from "../../src/protocol";
import { h } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";

type Post = (request: ChatRequest) => void;

const SVG_NS = "http://www.w3.org/2000/svg";
const RING_RADIUS = 6;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;
/** At or above this percentage the ring turns red. */
const FULL_PERCENT = 90;

function formatCost(cost: number): string {
	return cost > 0 && cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
}

function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1000) return `${Math.round(tokens / 1000)}k`;
	return String(tokens);
}

function svgCircle(className: string): SVGCircleElement {
	const circle = document.createElementNS(SVG_NS, "circle");
	for (const [key, value] of Object.entries({ class: className, cx: "8", cy: "8", r: String(RING_RADIUS) })) {
		circle.setAttribute(key, value);
	}
	return circle;
}

/** Context commands offered in the popover; each runs omp's slash command of the same name. */
const CONTEXT_ACTIONS = [
	{
		label: "Compact",
		icon: "shrink",
		command: "/compact",
		help: "Compact (/compact): summarize the older conversation into a short recap and continue from it. Frees the most context; earlier details survive only as the summary.",
	},
	{
		label: "Clean up",
		icon: "eraser",
		command: "/shake",
		help: "Clean up (/shake): drop heavy content from the context (old tool results and large blocks) without summarizing. Your messages and omp's answers stay as they are.",
	},
	{
		label: "Handoff",
		icon: "handoff",
		command: "/handoff",
		help: "Handoff (/handoff): write a handoff document with the goal, decisions, current state and next steps, then compact in place so the work continues from it with a fresh context.",
	},
] as const;

export class ContextMeter {
	readonly element: HTMLElement;
	#trigger = h("button", {
		type: "button",
		className: "context-ring",
		ariaLabel: "Context window",
		ariaHasPopup: "dialog",
	});
	#progress = svgCircle("ring-progress");
	#popover = h("div", { className: "context-popover", role: "dialog", ariaLabel: "Context window", hidden: true });
	#actions: HTMLButtonElement[];
	#busy = false;

	constructor(private readonly post: Post) {
		const ring = document.createElementNS(SVG_NS, "svg");
		for (const [key, value] of Object.entries({ width: "16", height: "16", viewBox: "0 0 16 16" })) {
			ring.setAttribute(key, value);
		}
		this.#progress.setAttribute("stroke-dasharray", String(RING_LENGTH));
		ring.append(svgCircle("ring-track"), this.#progress);
		this.#trigger.append(ring);
		this.#actions = CONTEXT_ACTIONS.map(action => {
			const element = h(
				"button",
				{ type: "button", className: "context-action" },
				icon(action.icon),
				h("span", null, action.label),
			);
			element.addEventListener("click", () => {
				this.post({ type: "prompt", text: action.command });
				this.#close();
			});
			return element;
		});
		this.element = h("div", { className: "context-meter", hidden: true }, this.#trigger, this.#popover);
		this.#trigger.addEventListener("click", () => (this.#popover.hidden ? this.#open() : this.#close()));
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
	}

	setUsage(state: SessionState, stats: SessionStats | undefined): void {
		const usage = state.contextUsage ?? stats?.contextUsage;
		this.element.hidden = !usage;
		if (!usage) {
			this.#close();
			return;
		}
		const percent = Math.min(100, Math.max(0, Math.round(usage.percent)));
		this.#progress.setAttribute("stroke-dashoffset", String(RING_LENGTH * (1 - percent / 100)));
		this.element.classList.toggle("full", percent >= FULL_PERCENT);
		const used = `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens used`;
		setTooltip(this.#trigger, `Context window: ${percent}% used (${100 - percent}% left)\n${used}`);

		const bar = h("div", { className: "context-bar" }, h("div", { className: "context-bar-fill" }));
		(bar.firstElementChild as HTMLElement).style.width = `${percent}%`;
		const rows: HTMLElement[] = [];
		const row = (label: string, value: string) =>
			h(
				"div",
				{ className: "context-row" },
				h("span", null, label),
				h("span", { className: "context-value" }, value),
			);
		if (stats) {
			// Token counts are summed over every model request of the session; each request sends
			// the whole context again, so they grow far past the context window (2.3M input for a
			// 33k context after ~70 requests is expected).
			const requests = stats.assistantMessages;
			rows.push(
				h(
					"div",
					{
						className: "context-section",
						dataset: {
							tooltip:
								"Totals over every model request of this session. Each request sends the whole conversation again, so these grow much faster than the context window above.",
						},
					},
					`Session totals · ${requests} ${requests === 1 ? "request" : "requests"}`,
				),
				row("Input sent", formatTokens(stats.tokens.input)),
				row("Output", formatTokens(stats.tokens.output)),
			);
			if (stats.tokens.cacheRead > 0) rows.push(row("Cache read", formatTokens(stats.tokens.cacheRead)));
			if (stats.tokens.cacheWrite > 0) rows.push(row("Cache write", formatTokens(stats.tokens.cacheWrite)));
			rows.push(row("Cost", formatCost(stats.cost)));
		}
		this.#popover.replaceChildren(
			h("div", { className: "context-title" }, "Context window"),
			h("div", { className: "context-summary" }, `${percent}% used (${100 - percent}% left)`),
			bar,
			h("div", { className: "context-detail" }, used),
			...rows,
			h("div", { className: "context-actions" }, ...this.#actions),
		);
		this.#refreshActions();
	}

	setBusy(busy: boolean): void {
		this.#busy = busy;
		this.#refreshActions();
	}

	/** The commands run between turns: disabled (with the reason in the tooltip) while omp replies. */
	#refreshActions(): void {
		for (const [index, action] of CONTEXT_ACTIONS.entries()) {
			const element = this.#actions[index]!;
			element.disabled = this.#busy;
			setTooltip(element, this.#busy ? `${action.help}\n\nWait for the reply to finish.` : action.help);
		}
	}

	#open(): void {
		this.#popover.hidden = false;
		this.#trigger.ariaExpanded = "true";
	}

	#close(): void {
		this.#popover.hidden = true;
		this.#trigger.ariaExpanded = "false";
	}
}
