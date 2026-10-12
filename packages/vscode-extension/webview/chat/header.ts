/** Header bar: session title, model and thinking selectors, context/cost meter, New/History. */
import type { ChatRequest, ModelChoice, SessionState, SessionStats, ThinkingLevel } from "../../src/protocol";
import { button, h } from "../dom";

type Post = (request: ChatRequest) => void;

function formatCost(cost: number): string {
	return cost > 0 && cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
}

export class Header {
	readonly element: HTMLElement;
	#title = h("div", { className: "session-title" }, "New session");
	#model = h("select", { className: "model-select", title: "Model" });
	#thinking = h("select", { className: "thinking-select", title: "Thinking level", hidden: true });
	#meter = h("span", { className: "meter" });
	#models: ModelChoice[] = [];
	#currentModel = "";
	#currentModelName = "";

	constructor(private readonly post: Post) {
		this.#model.addEventListener("change", () => {
			const [provider, ...rest] = this.#model.value.split("/");
			this.#currentModel = this.#model.value;
			this.post({ type: "setModel", provider: provider!, modelId: rest.join("/") });
		});
		this.#thinking.addEventListener("change", () => {
			this.post({ type: "setThinkingLevel", level: this.#thinking.value as ThinkingLevel });
		});
		this.element = h(
			"header",
			{ className: "header" },
			h(
				"div",
				{ className: "header-row" },
				this.#title,
				h(
					"div",
					{ className: "header-actions" },
					button("New", "text-button", () => this.post({ type: "newSession" })),
					button("History", "text-button", () => this.post({ type: "showSessions" })),
				),
			),
			h("div", { className: "header-row controls" }, this.#model, this.#thinking, this.#meter),
		);
		this.#renderModels();
	}

	setState(state: SessionState, stats: SessionStats | undefined, title: string | undefined): void {
		const name = title || state.sessionName || "New session";
		this.#title.textContent = name;
		this.#title.title = name;
		if (state.model) {
			this.#currentModel = `${state.model.provider}/${state.model.id}`;
			this.#currentModelName = state.model.name;
			this.#renderModels();
		}
		if (state.thinkingLevel) this.setThinkingLevel(state.thinkingLevel);

		const usage = state.contextUsage ?? stats?.contextUsage;
		const parts: string[] = [];
		const tooltip: string[] = [];
		if (usage) {
			parts.push(`${Math.round(usage.percent)}% context`);
			tooltip.push(`${usage.tokens.toLocaleString()} / ${usage.contextWindow.toLocaleString()} tokens`);
		}
		if (stats) {
			parts.push(formatCost(stats.cost));
			tooltip.push(`Session cost ${formatCost(stats.cost)}`);
		}
		this.#meter.textContent = parts.join(" · ");
		this.#meter.title = tooltip.join("\n");
	}

	setModels(models: ModelChoice[]): void {
		this.#models = models;
		this.#renderModels();
	}

	setThinkingLevels(levels: ThinkingLevel[]): void {
		const current = this.#thinking.value;
		this.#thinking.replaceChildren(...levels.map(level => h("option", { value: level }, `Think: ${level}`)));
		this.#thinking.hidden = levels.length === 0;
		if (current) this.setThinkingLevel(current as ThinkingLevel);
	}

	setThinkingLevel(level: ThinkingLevel): void {
		if (![...this.#thinking.options].some(option => option.value === level)) {
			this.#thinking.append(h("option", { value: level }, `Think: ${level}`));
		}
		this.#thinking.value = level;
	}

	/** Options grouped by provider; the current model is kept even if the catalog lacks it. */
	#renderModels(): void {
		const byProvider = new Map<string, HTMLOptGroupElement>();
		for (const model of this.#models) {
			let group = byProvider.get(model.provider);
			if (!group) {
				group = h("optgroup", { label: model.provider });
				byProvider.set(model.provider, group);
			}
			group.append(h("option", { value: `${model.provider}/${model.id}` }, model.name || model.id));
		}
		const options: HTMLElement[] = [...byProvider.values()];
		const known = this.#models.some(model => `${model.provider}/${model.id}` === this.#currentModel);
		if (this.#currentModel && !known) {
			options.unshift(h("option", { value: this.#currentModel }, this.#currentModelName || this.#currentModel));
		}
		if (!this.#currentModel) options.unshift(h("option", { value: "", disabled: true }, "No model"));
		this.#model.replaceChildren(...options);
		this.#model.value = this.#currentModel;
		this.#model.title = this.#currentModel || "Model";
	}
}
