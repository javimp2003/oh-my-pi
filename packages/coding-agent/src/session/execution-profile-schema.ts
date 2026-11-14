import { isRecord } from "@oh-my-pi/pi-utils";
import type { EditMode } from "@oh-my-pi/pi-tui/tools/edit-mode";
import { normalizeEditMode } from "../edit/modes";

export interface ExecutionProfile {
	version: 1;
	id: string;
	target: { provider: string; model: string; backend: string };
	settings: { "edit.mode": EditMode; "tools.xdevDocs": "inline" | "builtins" | "catalog" };
	measurement: {
		split: "development";
		taskIds: string[];
		passed: number;
		total: number;
		totalCostUsd: number;
		costPerPassUsd: number;
		meanDurationMs: number;
	};
}
/** Explicit user-selected configuration, never a model-name heuristic or unmeasured default. */
export function parseExecutionProfile(value: unknown): ExecutionProfile {
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		typeof value.id !== "string" ||
		!value.id.trim() ||
		!isRecord(value.settings) ||
		!isRecord(value.target) ||
		!isRecord(value.measurement)
	)
		throw new Error("Invalid execution profile");
	const target = value.target;
	if (
		typeof target.provider !== "string" ||
		!target.provider ||
		typeof target.model !== "string" ||
		!target.model ||
		typeof target.backend !== "string" ||
		!target.backend
	)
		throw new Error("Profile needs its measured model and backend identity");
	const edit = normalizeEditMode(
		typeof value.settings["edit.mode"] === "string" ? value.settings["edit.mode"] : undefined,
	);
	const docs = value.settings["tools.xdevDocs"];
	if (
		!edit ||
		(docs !== "inline" && docs !== "builtins" && docs !== "catalog") ||
		Object.keys(value.settings).some(key => key !== "edit.mode" && key !== "tools.xdevDocs")
	)
		throw new Error("Profile settings must specify only edit.mode and tools.xdevDocs");
	const m = value.measurement;
	if (
		m.split !== "development" ||
		!Array.isArray(m.taskIds) ||
		!m.taskIds.length ||
		!m.taskIds.every(id => typeof id === "string" && id.trim()) ||
		new Set(m.taskIds).size !== m.taskIds.length ||
		!Number.isInteger(m.total) ||
		m.total !== m.taskIds.length ||
		!Number.isInteger(m.passed) ||
		typeof m.passed !== "number" ||
		m.passed <= 0 ||
		m.passed > m.total ||
		typeof m.totalCostUsd !== "number" ||
		!Number.isFinite(m.totalCostUsd) ||
		m.totalCostUsd < 0 ||
		typeof m.costPerPassUsd !== "number" ||
		!Number.isFinite(m.costPerPassUsd) ||
		Math.abs(m.costPerPassUsd - m.totalCostUsd / m.passed) > 1e-8 ||
		typeof m.meanDurationMs !== "number" ||
		!Number.isFinite(m.meanDurationMs) ||
		m.meanDurationMs < 0
	)
		throw new Error("Profile needs complete development-only measurements including the cost of failed trials");
	return {
		version: 1,
		id: value.id,
		target: { provider: target.provider, model: target.model, backend: target.backend },
		settings: { "edit.mode": edit, "tools.xdevDocs": docs },
		measurement: {
			split: "development",
			taskIds: [...m.taskIds] as string[],
			passed: m.passed,
			total: m.total,
			totalCostUsd: m.totalCostUsd,
			costPerPassUsd: m.costPerPassUsd,
			meanDurationMs: m.meanDurationMs,
		},
	};
}
