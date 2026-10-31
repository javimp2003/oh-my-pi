/**
 * omp settings editor (editor-tab webview). Renders `omp config list --json`
 * entries as a tabbed, searchable form; every edit becomes a `set`/`reset`
 * request and the host answers with `saved`.
 */
import type { SettingEntry, SettingsRequest, SettingsUpdate } from "../../src/protocol";
import { getVsCodeApi } from "../vscode-api";
import { h } from "../dom";
import { CONTROL_CLASS, createCheckbox, createEditor, type EditorCallbacks } from "./editors";
import { advancedGroup, groupEntries, isModified, listTabs, matchesSearch, tabLabel, tabOf } from "./model";

/** Persisted across reloads via `vscode.setState`. */
interface ViewState {
	tab: string;
	search: string;
	showAdvanced: boolean;
}

const SAVED_TICK_MS = 1500;

const vscode = getVsCodeApi<SettingsRequest, ViewState>();
const view: ViewState = { tab: "", search: "", showAdvanced: false, ...vscode.getState() };

let entries: SettingEntry[] | undefined;
/** Last save error per key; cleared on the next edit of that row. */
const rowErrors = new Map<string, string>();
/** What the in-flight request for a key did, to interpret a `saved` without `value`. */
const pending = new Map<string, "set" | "reset">();
/** Rendered rows by key, for in-place updates after `saved`. */
const rows = new Map<string, HTMLElement>();

// ── Static skeleton ──────────────────────────────────────────────────────────

const configPathEl = h("span", { className: "config-path" });
const openConfigButton = h("button", { className: "secondary", textContent: "Open config.yml" });
const refreshButton = h("button", { className: "secondary", textContent: "Refresh" });
const bannerText = h("span");
const bannerClose = h("button", { className: "icon", textContent: "×", title: "Dismiss" });
const banner = h("div", { className: "banner", hidden: true, role: "alert" }, bannerText, bannerClose);
const searchInput = h("input", {
	type: "search",
	className: "search",
	placeholder: "Search settings",
	value: view.search,
	spellcheck: false,
});
const tabSelect = h("select", { className: "tab-select", title: "Settings tab" });
const advancedToggle = h("input", { type: "checkbox", checked: view.showAdvanced });
const nav = h("nav", { className: "nav" });
const content = h("main", { className: "content" }, h("p", { className: "empty", textContent: "Loading settings…" }));

document
	.getElementById("root")!
	.append(
		h(
			"div",
			{ className: "app" },
			h(
				"header",
				{ className: "header" },
				h("div", { className: "title" }, h("h1", { textContent: "MarIA Code Settings" }), configPathEl),
				h("div", { className: "actions" }, openConfigButton, refreshButton),
			),
			banner,
			h(
				"div",
				{ className: "toolbar" },
				searchInput,
				tabSelect,
				h("label", { className: "advanced-toggle" }, advancedToggle, "Show advanced (config-file) settings"),
			),
			h("div", { className: "body" }, nav, content),
		),
	);

openConfigButton.addEventListener("click", () => vscode.postMessage({ type: "openConfigFile" }));
refreshButton.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
bannerClose.addEventListener("click", () => {
	banner.hidden = true;
});
searchInput.addEventListener("input", () => {
	view.search = searchInput.value;
	render(true);
});
searchInput.addEventListener("keydown", event => {
	if (event.key === "Escape" && searchInput.value) {
		searchInput.value = "";
		view.search = "";
		render(true);
	}
});
tabSelect.addEventListener("change", () => selectTab(tabSelect.value));
advancedToggle.addEventListener("change", () => {
	view.showAdvanced = advancedToggle.checked;
	render(false);
});

function selectTab(tab: string): void {
	view.tab = tab;
	view.search = "";
	searchInput.value = "";
	render(true);
}

// ── Rendering ────────────────────────────────────────────────────────────────

/** Rebuilds nav and content from `entries` and `view`; persists `view`. */
function render(scrollToTop: boolean): void {
	if (!entries) return;
	const tabs = listTabs(entries, view.showAdvanced);
	if (!tabs.some(tab => tab.id === view.tab)) view.tab = tabs[0]?.id ?? "";
	vscode.setState(view);

	const searching = view.search.trim() !== "";
	nav.replaceChildren(
		...tabs.map(tab => {
			const button = h("button", {
				className: tab.id === view.tab && !searching ? "nav-item active" : "nav-item",
				textContent: tab.label,
			});
			button.addEventListener("click", () => selectTab(tab.id));
			return button;
		}),
	);
	tabSelect.replaceChildren(
		...(searching ? [h("option", { value: "", textContent: "Search results", disabled: true, selected: true })] : []),
		...tabs.map(tab =>
			h("option", { value: tab.id, textContent: tab.label, selected: tab.id === view.tab && !searching }),
		),
	);

	rows.clear();
	const scrollTop = content.scrollTop;
	content.replaceChildren(...(searching ? renderSearch(entries) : renderTab(entries, tabs)));
	content.scrollTop = scrollToTop ? 0 : scrollTop;
}

function renderTab(all: SettingEntry[], tabs: { id: string; label: string }[]): Node[] {
	const tab = tabs.find(candidate => candidate.id === view.tab);
	if (!tab) return [h("p", { className: "empty", textContent: "No settings." })];
	const nodes: Node[] = [h("h2", { textContent: tab.label })];
	for (const group of groupEntries(all.filter(entry => tabOf(entry) === tab.id))) {
		if (group.title) nodes.push(h("h3", { textContent: group.title }));
		for (const entry of group.entries) nodes.push(buildRow(entry, false));
	}
	return nodes;
}

function renderSearch(all: SettingEntry[]): Node[] {
	const query = view.search.trim();
	const matches = all.filter(entry => matchesSearch(entry, query));
	const visible = matches.filter(entry => entry.ui || view.showAdvanced);
	const hiddenAdvanced = matches.length - visible.length;
	const summary = h("p", {
		className: "search-summary",
		textContent: visible.length === 1 ? "1 setting found" : `${visible.length} settings found`,
	});
	const nodes: Node[] = [summary];
	if (visible.length === 0) summary.textContent = `No settings match “${query}”.`;
	if (hiddenAdvanced > 0) {
		const reveal = h("button", {
			className: "link",
			textContent: `Show ${hiddenAdvanced} more in advanced (config-file) settings`,
		});
		reveal.addEventListener("click", () => {
			view.showAdvanced = true;
			advancedToggle.checked = true;
			render(false);
		});
		summary.append(" ", reveal);
	}
	for (const entry of visible) nodes.push(buildRow(entry, true));
	return nodes;
}

function buildRow(entry: SettingEntry, showLocation: boolean): HTMLElement {
	const callbacks: EditorCallbacks = {
		commit: value => {
			pending.set(entry.key, "set");
			vscode.postMessage({ type: "set", key: entry.key, value });
		},
		edited: () => setRowError(entry.key, undefined),
	};
	const modified = isModified(entry);
	const row = h("div", { className: modified ? "setting modified" : "setting", dataset: { key: entry.key } });

	if (showLocation) {
		const location = entry.ui ? [tabLabel(entry.ui.tab), entry.ui.group] : ["Advanced", advancedGroup(entry.key)];
		row.append(h("div", { className: "location", textContent: location.filter(Boolean).join(" › ") }));
	}

	// Config-file-only settings have no label; their key is the heading.
	const header = entry.ui
		? h(
				"div",
				{ className: "setting-header" },
				h("span", { className: "label", textContent: entry.ui.label }),
				h("code", { className: "key", textContent: entry.key }),
			)
		: h("div", { className: "setting-header" }, h("code", { className: "label", textContent: entry.key }));
	if (modified) {
		const reset = h("button", {
			className: "link",
			textContent: "Reset",
			title: entry.redacted ? "Remove the stored value" : "Reset to the default value",
		});
		reset.addEventListener("click", () => {
			pending.set(entry.key, "reset");
			setRowError(entry.key, undefined);
			vscode.postMessage({ type: "reset", key: entry.key });
		});
		const marker = entry.redacted ? "Set" : "Modified";
		header.append(h("span", { className: "modified-marker", textContent: marker }), reset);
	}
	header.append(h("span", { className: "saved-tick", textContent: "✓ Saved", hidden: true }));
	row.append(header);

	if (entry.type === "boolean") {
		row.append(
			h(
				"label",
				{ className: "checkbox-row" },
				createCheckbox(entry, callbacks),
				h("span", { className: "description", textContent: entry.description || "Enabled" }),
			),
		);
	} else if (entry.description) {
		row.append(h("div", { className: "description", textContent: entry.description }));
	}
	if (entry.ui?.warning) row.append(h("div", { className: "warning", textContent: `⚠ ${entry.ui.warning}` }));
	if (entry.type !== "boolean") row.append(createEditor(entry, callbacks));

	const error = rowErrors.get(entry.key);
	row.append(h("div", { className: "error row-error", textContent: error ?? "", hidden: !error }));
	rows.set(entry.key, row);
	return row;
}

function setRowError(key: string, error: string | undefined): void {
	if (error) rowErrors.set(key, error);
	else if (!rowErrors.delete(key)) return;
	const element = rows.get(key)?.querySelector<HTMLElement>(".row-error");
	if (!element) return;
	element.textContent = error ?? "";
	element.hidden = !error;
}

/** Re-renders one row in place (keeping focus on its control) and flashes "Saved". */
function refreshRow(entry: SettingEntry): void {
	const old = rows.get(entry.key);
	if (!old) return;
	const hadFocus = old.contains(document.activeElement);
	const row = buildRow(entry, old.querySelector(".location") !== null);
	old.replaceWith(row);
	if (hadFocus) row.querySelector<HTMLElement>(`.${CONTROL_CLASS}`)?.focus();
	const tick = row.querySelector<HTMLElement>(".saved-tick")!;
	tick.hidden = false;
	setTimeout(() => {
		tick.hidden = true;
	}, SAVED_TICK_MS);
}

// ── Host messages ────────────────────────────────────────────────────────────

function applySaved(key: string, value: unknown, error: string | undefined): void {
	const action = pending.get(key);
	pending.delete(key);
	if (error) {
		setRowError(key, error);
		return;
	}
	const entry = entries?.find(candidate => candidate.key === key);
	if (!entry) return;
	rowErrors.delete(key);
	if (value !== undefined) {
		entry.value = value;
		delete entry.redacted;
	} else {
		// omp omits `value` for a stored credential and for an unset setting.
		delete entry.value;
		if (action === "set") entry.redacted = true;
		else delete entry.redacted;
	}
	refreshRow(entry);
}

window.addEventListener("message", (event: MessageEvent<SettingsUpdate>) => {
	const message = event.data;
	switch (message.type) {
		case "settings":
			entries = message.entries;
			configPathEl.textContent = message.configPath;
			configPathEl.title = message.configPath;
			render(false);
			break;
		case "saved":
			applySaved(message.key, message.value, message.error);
			break;
		case "error":
			bannerText.textContent = message.message;
			banner.hidden = false;
			break;
	}
});

vscode.postMessage({ type: "ready" });
