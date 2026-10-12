/**
 * Pure helpers over `SettingEntry[]`: tab/group layout, search, and value
 * comparison. No DOM access.
 */
import type { SettingEntry } from "../../src/protocol";

/** Tab id for entries without `ui` (config-file-only settings). */
export const ADVANCED_TAB = "advanced";

export interface Tab {
	id: string;
	label: string;
}

export interface Group {
	/** Heading; empty for the ungrouped settings at the top of a tab. */
	title: string;
	entries: SettingEntry[];
}

export function tabOf(entry: SettingEntry): string {
	return entry.ui?.tab ?? ADVANCED_TAB;
}

/** "model" → "Model", "file-tools" → "File Tools". */
export function tabLabel(id: string): string {
	return id
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map(word => word[0]!.toUpperCase() + word.slice(1))
		.join(" ");
}

/** Tabs in first-appearance order; "Advanced" last when requested and non-empty. */
export function listTabs(entries: SettingEntry[], showAdvanced: boolean): Tab[] {
	const ids: string[] = [];
	let hasAdvanced = false;
	for (const entry of entries) {
		if (!entry.ui) {
			hasAdvanced = true;
			continue;
		}
		if (!ids.includes(entry.ui.tab)) ids.push(entry.ui.tab);
	}
	const tabs = ids.map(id => ({ id, label: tabLabel(id) }));
	if (showAdvanced && hasAdvanced) tabs.push({ id: ADVANCED_TAB, label: "Advanced" });
	return tabs;
}

/**
 * Groups a tab's entries in their given order, ungrouped first. Advanced
 * entries have no `ui.group`, so they group by their first key segment.
 */
export function groupEntries(entries: SettingEntry[]): Group[] {
	const ungrouped: SettingEntry[] = [];
	const groups = new Map<string, SettingEntry[]>();
	for (const entry of entries) {
		const title = entry.ui ? (entry.ui.group ?? "") : advancedGroup(entry.key);
		if (!title) {
			ungrouped.push(entry);
			continue;
		}
		let list = groups.get(title);
		if (!list) {
			list = [];
			groups.set(title, list);
		}
		list.push(entry);
	}
	const result: Group[] = [];
	if (ungrouped.length > 0) result.push({ title: "", entries: ungrouped });
	for (const [title, list] of groups) result.push({ title, entries: list });
	return result;
}

/** Group of a config-file-only setting: its first key segment ("" for top-level keys). */
export function advancedGroup(key: string): string {
	const dot = key.indexOf(".");
	return dot === -1 ? "" : key.slice(0, dot);
}

/** Case-insensitive match of every whitespace-separated term against key, label, or description. */
export function matchesSearch(entry: SettingEntry, query: string): boolean {
	const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (terms.length === 0) return true;
	const haystack = `${entry.key}\n${entry.ui?.label ?? ""}\n${entry.description}`.toLowerCase();
	return terms.every(term => haystack.includes(term));
}

/** The value omp uses: the explicit value, else the default. */
export function effectiveValue(entry: SettingEntry): unknown {
	return entry.value !== undefined ? entry.value : entry.default;
}

/** True when the setting deviates from its default (a stored credential always counts). */
export function isModified(entry: SettingEntry): boolean {
	if (entry.redacted) return true;
	if (entry.value === undefined) return false;
	return !deepEqual(entry.value, entry.default);
}

export function deepEqual(a: unknown, b: unknown): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (Array.isArray(a) && Array.isArray(b)) {
		return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
	}
	const aRecord = a as Record<string, unknown>;
	const bRecord = b as Record<string, unknown>;
	const aKeys = Object.keys(aRecord);
	if (aKeys.length !== Object.keys(bRecord).length) return false;
	return aKeys.every(key => Object.hasOwn(bRecord, key) && deepEqual(aRecord[key], bRecord[key]));
}
