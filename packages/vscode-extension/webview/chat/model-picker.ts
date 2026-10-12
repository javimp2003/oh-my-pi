/**
 * Composer model chip: shows the current model (and reasoning level) and opens
 * an upward menu with a "Reasoning" section and the model catalog grouped by
 * provider.
 */
import type { ChatRequest, ModelChoice, SessionState, ThinkingLevel } from "../../src/protocol";
import { h } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";

type Post = (request: ChatRequest) => void;
type CurrentModel = SessionState["model"];

/** A filter input appears above the catalog past this many models. */
const FILTER_THRESHOLD = 8;

const LEVEL_LABELS: Record<ThinkingLevel, string> = {
	inherit: "Inherit",
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "Extra high",
	max: "Max",
};

function label(level: ThinkingLevel): string {
	return LEVEL_LABELS[level] ?? level;
}

/** A selectable menu row and what picking it does. */
interface Item {
	el: HTMLElement;
	select(): void;
}

export class ModelPicker {
	readonly element: HTMLElement;
	#trigger = h("button", { type: "button", className: "picker-trigger", ariaLabel: "Model and reasoning" });
	#menu = h("div", { className: "picker-menu", role: "listbox", hidden: true });
	#filter = h("input", {
		type: "text",
		className: "picker-filter",
		placeholder: "Filter models",
		ariaLabel: "Filter models",
	});
	#list = h("div", { className: "picker-list" });
	#models: ModelChoice[] = [];
	#levels: ThinkingLevel[] = [];
	#level: ThinkingLevel | undefined;
	#current: CurrentModel;
	#items: Item[] = [];
	#selected = 0;

	constructor(private readonly post: Post) {
		this.#menu.append(this.#filter, this.#list);
		this.element = h("div", { className: "picker" }, this.#trigger, this.#menu);
		this.#trigger.addEventListener("click", () => (this.#menu.hidden ? this.#open() : this.#close()));
		this.#trigger.addEventListener("keydown", event => this.#onKeyDown(event));
		this.#filter.addEventListener("input", () => {
			this.#selected = 0;
			this.#renderMenu();
		});
		this.#filter.addEventListener("keydown", event => this.#onKeyDown(event));
		document.addEventListener("mousedown", event => {
			if (!this.#menu.hidden && !this.element.contains(event.target as Node)) this.#close();
		});
		this.#renderTrigger();
	}

	setModels(models: ModelChoice[]): void {
		this.#models = models;
		this.#refresh();
	}

	setThinkingLevels(levels: ThinkingLevel[]): void {
		this.#levels = levels;
		this.#refresh();
	}

	setThinkingLevel(level: ThinkingLevel): void {
		this.#level = level;
		this.#refresh();
	}

	setCurrent(model: CurrentModel): void {
		if (!model) return;
		this.#current = model;
		this.#refresh();
	}

	#refresh(): void {
		this.#renderTrigger();
		if (!this.#menu.hidden) this.#renderMenu();
	}

	#renderTrigger(): void {
		const model = this.#current ? this.#current.name || this.#current.id : "Select model";
		const level =
			this.#current && this.#levels.length > 0 && this.#level && this.#level !== "off"
				? ` · ${label(this.#level)}`
				: "";
		const chevron = icon("chevronDown");
		this.#trigger.replaceChildren(h("span", { className: "picker-text" }, model + level), chevron);
		setTooltip(this.#trigger, this.#current ? `${this.#current.provider}/${this.#current.id}` : "Select model");
	}

	#open(): void {
		this.#menu.hidden = false;
		this.#filter.value = "";
		this.#selected = 0;
		this.#renderMenu();
		const current = this.#items.findIndex(item => item.el.classList.contains("current"));
		if (current >= 0) this.#select(current);
		if (!this.#filter.hidden) this.#filter.focus();
	}

	#close(): void {
		this.#menu.hidden = true;
	}

	#renderMenu(): void {
		this.#filter.hidden = this.#models.length <= FILTER_THRESHOLD;
		const needle = this.#filter.hidden ? "" : this.#filter.value.trim().toLowerCase();
		const children: HTMLElement[] = [];
		this.#items = [];
		const row = (text: string, current: boolean, select: () => void) => {
			const el = h(
				"div",
				{ className: `picker-item${current ? " current" : ""}`, role: "option" },
				h("span", { className: "picker-item-label" }, text),
				current ? icon("check") : null,
			);
			const index = this.#items.length;
			el.addEventListener("mousemove", () => this.#select(index));
			el.addEventListener("click", () => {
				select();
				this.#close();
			});
			this.#items.push({ el, select });
			return el;
		};

		if (this.#levels.length > 0 && needle === "") {
			children.push(h("div", { className: "picker-section" }, "Reasoning"));
			for (const level of this.#levels) {
				children.push(
					row(label(level), level === this.#level, () => this.post({ type: "setThinkingLevel", level })),
				);
			}
		}

		// The current model stays listed even when the catalog lacks it.
		const current = this.#current;
		const models: Array<{ provider: string; id: string; name: string }> = [...this.#models];
		if (current && !models.some(model => model.provider === current.provider && model.id === current.id)) {
			models.unshift({ provider: current.provider, id: current.id, name: current.name });
		}
		const byProvider = new Map<string, HTMLElement[]>();
		for (const model of models) {
			const name = model.name || model.id;
			if (needle && !`${model.provider} ${model.id} ${name}`.toLowerCase().includes(needle)) continue;
			let group = byProvider.get(model.provider);
			if (!group) {
				group = [];
				byProvider.set(model.provider, group);
			}
			const isCurrent = current?.provider === model.provider && current.id === model.id;
			group.push(
				row(name, isCurrent, () => this.post({ type: "setModel", provider: model.provider, modelId: model.id })),
			);
		}
		children.push(h("div", { className: "picker-section" }, "Model"));
		if (byProvider.size === 0) {
			children.push(h("div", { className: "picker-empty" }, needle ? "No matches" : "No models"));
		}
		for (const [provider, rows] of byProvider) {
			children.push(h("div", { className: "picker-group" }, provider), ...rows);
		}
		this.#list.replaceChildren(...children);
		this.#select(Math.min(this.#selected, Math.max(0, this.#items.length - 1)));
	}

	#select(index: number): void {
		this.#items[this.#selected]?.el.classList.remove("selected");
		this.#selected = index;
		const item = this.#items[index];
		if (!item) return;
		item.el.classList.add("selected");
		item.el.scrollIntoView({ block: "nearest" });
	}

	#onKeyDown(event: KeyboardEvent): void {
		if (event.isComposing) return;
		if (this.#menu.hidden) {
			if (event.key === "ArrowUp" || event.key === "ArrowDown") {
				event.preventDefault();
				this.#open();
			}
			return;
		}
		const count = this.#items.length;
		switch (event.key) {
			case "ArrowDown":
			case "ArrowUp":
				event.preventDefault();
				if (count > 0) this.#select((this.#selected + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
				return;
			case "Enter": {
				event.preventDefault();
				const item = this.#items[this.#selected];
				if (item) {
					item.select();
					this.#close();
				}
				return;
			}
			case "Escape":
				event.preventDefault();
				this.#close();
				this.#trigger.focus();
				return;
		}
	}
}
