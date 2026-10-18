/**
 * omp's own messages in the conversation (custom and hook messages that are
 * not prompts): background job results, supervised process exits, extension
 * notices. They render as activity rows like tool calls, as the TUI shows
 * them, never as a user bubble; expanding a row shows the message text.
 */
import { h } from "../dom";
import { type IconName, icon } from "../icons";
import { truncatedPre } from "./tools";

interface NoticeRow {
	icon: IconName;
	verb: string;
	subject?: string;
	/** Muted text after the subject: job type, duration, exit code. */
	label?: string;
	failed?: boolean;
	/** Shown when the row is expanded; a row without it does not expand. */
	body?: string;
}

const JOB_ICONS: Record<string, IconName> = { bash: "bash", eval: "python", task: "bot" };

/** The element for a displayed custom message of type `customType`. */
export function noticeElement(customType: string, text: string, details: unknown): HTMLElement {
	const rows =
		customType === "async-result"
			? asyncResultRows(text, details)
			: customType === "launch-completion"
				? launchCompletionRows(text, details)
				: [{ icon: "wrench" as const, verb: customType, body: text }];
	return h("div", { className: "msg omp-notice" }, ...rows.map(noticeRow));
}

function noticeRow(row: NoticeRow): HTMLElement {
	const line = h(
		"div",
		{ className: "activity-line" },
		h("span", { className: "activity-icon" }, icon(row.icon)),
		h("span", { className: "activity-verb" }, row.verb),
		row.subject ? h("span", { className: "activity-subject code" }, row.subject) : null,
		row.label ? h("span", { className: "activity-label" }, row.label) : null,
		row.failed ? h("span", { className: "activity-state error" }, "Failed") : null,
		row.body ? h("span", { className: "activity-chevron" }, icon("chevronRight")) : null,
	);
	if (!row.body) return h("div", { className: "activity static" }, h("div", { className: "activity-row" }, line));
	return h(
		"details",
		{ className: "activity" },
		h("summary", { className: "activity-row" }, line),
		h("div", { className: "activity-body" }, truncatedPre(row.body, "activity-pre")),
	);
}

/** `async-result`: one row per finished background job; the body is the delivered output. */
function asyncResultRows(text: string, details: unknown): NoticeRow[] {
	const jobs = record(details) && Array.isArray(details.jobs) ? details.jobs.filter(record) : [];
	// The text is what the model received, wrapped in a `<system-notice>` the user does not need to see.
	const body = text.replace(/^\s*<system-notice>\s*/, "").replace(/\s*<\/system-notice>\s*$/, "");
	if (jobs.length === 0) return [{ icon: "check", verb: "Background job completed", body }];
	return jobs.map((job, index) => {
		const type = string(job.type);
		const status = string(job.status);
		const duration = typeof job.durationMs === "number" ? formatDuration(job.durationMs) : undefined;
		// A bash job's label is its command: shown above the output, like a Bash row.
		const command = type === "bash" ? string(job.label) : undefined;
		return {
			icon: (type && JOB_ICONS[type]) || "check",
			verb:
				status === "failed"
					? "Background job failed"
					: status === "cancelled"
						? "Background job cancelled"
						: "Background job completed",
			subject: string(job.jobId),
			label: [type, duration].filter(Boolean).join(" · ") || undefined,
			failed: status === "failed",
			// Several jobs share one delivery text: it goes under the first row.
			body: index === 0 ? (command && jobs.length === 1 ? `$ ${command}\n\n${body}` : body) : undefined,
		};
	});
}

/** `launch-completion`: one row per supervised process that exited. */
function launchCompletionRows(text: string, details: unknown): NoticeRow[] {
	const daemons = record(details) && Array.isArray(details.daemons) ? details.daemons.filter(record) : [];
	if (daemons.length === 0) return [{ icon: "terminal", verb: text || "Supervised process completed" }];
	return daemons.map(daemon => {
		const exitCode = typeof daemon.exitCode === "number" ? daemon.exitCode : undefined;
		const failed = daemon.state === "failed" || (exitCode !== undefined && exitCode !== 0);
		const started = typeof daemon.startedAt === "number" ? daemon.startedAt : undefined;
		const exited = typeof daemon.exitedAt === "number" ? daemon.exitedAt : undefined;
		const duration = started !== undefined && exited !== undefined ? formatDuration(exited - started) : undefined;
		return {
			icon: "terminal" as const,
			verb: failed ? "Supervised process failed" : "Supervised process completed",
			subject: string(daemon.name),
			label:
				[exitCode !== undefined ? `exit ${exitCode}` : undefined, duration].filter(Boolean).join(" · ") ||
				undefined,
			failed,
		};
	});
}

function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)}s`;
	const minutes = Math.floor(seconds / 60);
	return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}
