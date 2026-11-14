import { Input } from "../components/input";
import { SelectList, type SelectItem } from "../components/select-list";
import { TabBar } from "../components/tab-bar";
import { bottomBorder, divider, row, topBorder } from "../chrome/overlay-box";
import { getTabBarTheme } from "../chrome/shared";
import { editorKey, editorKeys } from "../chrome/keybinding-hints";
import { getKeybindings } from "../keybindings";
import { matchesKey } from "../keys";
import { routeSgrMouseInput } from "../mouse";
import { text } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, hintsRow, overlayCard } from "../native/overlay";
import { getSelectListTheme, theme } from "../theme/theme";
import type { Component } from "../tui";
import { truncateToWidth, wrapTextWithAnsi } from "../utils";
import { sanitizeDisplayLine } from "./extensions/display-text";

export interface WorkbenchItem {
	id: string;
	category: string;
	label: string;
	description: string;
	command: string;
}

export interface WorkbenchOptions {
	items: readonly WorkbenchItem[];
	session: string;
	workspace: string;
	model: string;
	state: string;
	getHeight?: () => number;
	onSelect: (id: string) => void;
	onCancel: () => void;
}

/** Responsive command navigation; execution remains the application's responsibility. */
export class WorkbenchComponent implements Component {
	readonly items: readonly WorkbenchItem[];
	readonly #options: WorkbenchOptions;
	readonly #tabs: TabBar;
	readonly #search = new Input();
	readonly #list: SelectList;
	#category = "all";
	#tabsStart = 0;
	#tabsCount = 0;
	#listStart = 0;
	#listRows = 0;
	#compactTabs = false;

	constructor(options: WorkbenchOptions) {
		this.#options = options;
		this.items = options.items.map(item => ({
			...item,
			category: sanitizeDisplayLine(item.category),
			label: sanitizeDisplayLine(item.label),
			description: sanitizeDisplayLine(item.description),
			command: sanitizeDisplayLine(item.command),
		}));
		this.#tabs = new TabBar(
			"",
			[
				{ id: "all", label: "All actions" },
				...[...new Set(this.items.map(item => item.category))].map(category => ({ id: category, label: category })),
			],
			getTabBarTheme(),
		);
		this.#tabs.showHint = false;
		this.#tabs.onTabChange = tab => {
			this.#category = tab.id;
			this.#search.setValue("");
			this.#updateItems();
		};
		this.#search.prompt = "";
		this.#list = new SelectList([], 10, getSelectListTheme(), {
			search: "never",
			statusText: () => undefined,
			noMatchText: "No matching actions. Try another search.",
			emptyText: "No actions available.",
		});
		this.#list.onSelect = item => options.onSelect(item.value);
		this.#list.onCancel = options.onCancel;
		this.#updateItems();
	}

	#updateItems(): void {
		const items: SelectItem[] = this.items
			.filter(item => this.#category === "all" || item.category === this.#category)
			.map(item => ({
				value: item.id,
				label: this.#category === "all" ? `${item.category} / ${item.label}` : item.label,
				description: item.command,
				searchText: `${item.category} ${item.description}`,
			}));
		this.#list.setItems(items);
		this.#list.setFilter(this.#search.getValue());
	}

	#detail(): WorkbenchItem | undefined {
		const selected = this.#list.getSelectedItem();
		return selected ? this.items.find(item => item.id === selected.value) : undefined;
	}

	render(width: number): readonly string[] {
		const height = Math.max(8, Math.min(34, this.#options.getHeight?.() ?? process.stdout.rows ?? 30));
		const inner = Math.max(1, width - 4);
		const small = height < 18;
		const out = [topBorder(width, "MarIA Code / Workbench")];
		if (height > 8)
			out.push(
				row(
					`${theme.fg(this.#options.state === "ready" ? "success" : "accent", sanitizeDisplayLine(this.#options.state).toUpperCase())}  ${theme.bold(sanitizeDisplayLine(this.#options.session))}`,
					width,
				),
			);
		if (!small) {
			out.push(row(theme.fg("muted", "Workspace  ") + sanitizeDisplayLine(this.#options.workspace), width));
			out.push(row(theme.fg("muted", "Model      ") + sanitizeDisplayLine(this.#options.model), width));
			out.push(divider(width));
		}
		this.#tabsStart = out.length;
		this.#compactTabs = width < 60 || small;
		const tabs = this.#compactTabs ? [theme.fg("accent", this.#tabs.getActiveTab().label)] : this.#tabs.render(inner);
		this.#tabsCount = tabs.length;
		out.push(...tabs.map(line => row(line, width)));
		const count = this.#list.pickerView().items.length;
		const search = this.#search.render(Math.max(1, inner - 8))[0] ?? "";
		out.push(row(theme.fg("muted", "Search  ") + search, width));
		out.push(divider(width));
		const detail = this.#detail();
		const detailLines = small
			? []
			: wrapTextWithAnsi(detail?.description ?? "No matches. Change the search or category.", inner).slice(0, 2);
		const hints =
			small || width < 60
				? `${editorKey("tui.select.confirm")} open | ${editorKey("tui.select.cancel")} back | Tab category`
				: `${editorKeys("tui.select.up", "tui.select.down")} select | ${editorKey("tui.select.confirm")} open | Tab category | ${editorKey("tui.select.cancel")} back`;
		const footerText =
			height <= 8
				? `${editorKey("tui.select.confirm")} open | ${editorKey("tui.select.cancel")} back`
				: `${count} ${count === 1 ? "action" : "actions"} | ${hints}`;
		const hintLines = wrapTextWithAnsi(footerText, inner).slice(0, height <= 8 ? 1 : 2);
		const footer = [
			divider(width),
			...detailLines.map(line => row(theme.fg("muted", line), width)),
			...hintLines.map(line => row(theme.fg("dim", line), width)),
			bottomBorder(width),
		];
		this.#listStart = out.length;
		this.#listRows = Math.max(1, height - out.length - footer.length);
		this.#list.setMaxVisible(this.#listRows);
		const lines = this.#list.render(inner);
		for (let index = 0; index < this.#listRows; index++) out.push(row(lines[index] ?? "", width));
		out.push(...footer);
		return out.map(line => truncateToWidth(line, width));
	}

	handleInput(data: string): void {
		if (data.startsWith("\x1b[<")) {
			routeSgrMouseInput(data, event => {
				const line = event.row - this.#listStart;
				if (line >= 0 && line < this.#listRows) this.#list.routeMouse(event, line, event.col - 2);
				const tabLine = event.row - this.#tabsStart;
				if (!this.#compactTabs && event.leftClick && tabLine >= 0 && tabLine < this.#tabsCount) {
					const tab = this.#tabs.tabAt(tabLine, event.col - 2);
					if (tab) this.#tabs.selectTab(tab.id);
				}
				return true;
			});
			return;
		}
		const keys = getKeybindings();
		if (keys.matches(data, "tui.select.cancel")) {
			if (this.#search.getValue()) {
				this.#search.setValue("");
				this.#updateItems();
			} else this.#options.onCancel();
			return;
		}
		if (
			matchesKey(data, "tab") ||
			matchesKey(data, "shift+tab") ||
			(!this.#search.getValue() && (matchesKey(data, "left") || matchesKey(data, "right")))
		) {
			this.#tabs.handleInput(data);
			return;
		}
		if (
			(
				[
					"tui.select.up",
					"tui.select.down",
					"tui.select.pageUp",
					"tui.select.pageDown",
					"tui.select.confirm",
				] as const
			).some(action => keys.matches(data, action)) ||
			data === "\n"
		) {
			this.#list.handleInput(data);
			return;
		}
		this.#search.handleInput(data);
		this.#list.setFilter(this.#search.getValue());
	}

	describe(context: DescribeContext): NativeNode {
		return overlayCard("omp.overlay.workbench", "MarIA Code / Workbench", [
			text(sanitizeDisplayLine(`${this.#options.state} | ${this.#options.session}`)),
			text(sanitizeDisplayLine(this.#options.workspace)),
			text(sanitizeDisplayLine(this.#options.model)),
			{ ...this.#tabs.describe(context), key: "tabs" },
			{ ...this.#search.describe(context), key: "search" },
			this.#list,
			text(this.#detail()?.description ?? "No matching actions"),
			hintsRow([
				actionHint("tui.select.confirm", "open"),
				{ keys: ["tab"], label: "category" },
				actionHint("tui.select.cancel", "back"),
			]),
		]);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.key === "search") {
			this.#search.handleNativeEvent(event);
			this.#list.setFilter(this.#search.getValue());
		} else if (event.key === "tabs") this.#tabs.handleNativeEvent(event);
		else if (event.type === "activate" || event.type === "select") this.#list.handleNativeEvent(event);
	}

	invalidate(): void {
		this.#tabs.invalidate();
		this.#search.invalidate();
		this.#list.invalidate();
	}
}
