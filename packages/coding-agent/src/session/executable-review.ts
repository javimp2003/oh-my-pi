import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { isRecord, Snowflake } from "@oh-my-pi/pi-utils";
import type { SessionManager } from "./session-manager";
import {
	sameVerificationRevisions,
	normalizeVerificationChecks,
	type VerificationCheck,
	type VerificationCheckStatus,
	type VerificationContracts,
} from "./verification-contract";

export interface ReviewFinding {
	check: string;
	description: string;
	receipt: string;
}
export interface ExecutableReviewReport {
	status: "clean" | "issues" | "blocked" | "stale";
	findings: ReviewFinding[];
	reason?: string;
}
export interface ExecutableReviewStatus {
	attempts: number;
	report?: ExecutableReviewReport;
}
export interface ReviewTicket {
	id: string;
	request: string;
	revisions: Record<string, string> | null;
	checks: VerificationCheckStatus[];
}
function sameChecks(left: readonly VerificationCheck[], right: readonly VerificationCheck[]): boolean {
	const shape = (checks: readonly VerificationCheck[]) =>
		checks.map(({ id, requirement, command, cwd, paths }) => ({ id, requirement, command, cwd, paths }));
	return JSON.stringify(shape(left)) === JSON.stringify(shape(right));
}
const ATTEMPT = "verification-review-attempt";
const REPORT = "verification-review-report";

/** A model claim is advisory unless a completed child run contains the cited real execution. */
export function auditExecutableReview(
	result: Pick<SingleResult, "exitCode" | "structuredOutput" | "receipts">,
	checks: readonly VerificationCheckStatus[],
): ExecutableReviewReport {
	const data = result.structuredOutput?.data;
	const blocked = (reason: string): ExecutableReviewReport => ({ status: "blocked", findings: [], reason });
	if (result.exitCode !== 0 || result.structuredOutput?.status !== "valid" || !isRecord(data))
		return blocked("Review did not finish with valid structured output");
	if (data.verdict === "blocked")
		return blocked(typeof data.reason === "string" ? data.reason : "Reviewer could not validate the change");
	if (data.verdict !== "clean" && data.verdict !== "issues") return blocked("Unknown review verdict");
	if (!Array.isArray(data.findings) || !Array.isArray(data.evidence)) return blocked("Missing review evidence");
	const receipts = new Map((result.receipts ?? []).map(receipt => [receipt.id, receipt]));
	const findings: ReviewFinding[] = [];
	for (const item of data.findings) {
		if (
			!isRecord(item) ||
			typeof item.check !== "string" ||
			!checks.some(check => check.id === item.check) ||
			typeof item.description !== "string" ||
			!item.description.trim() ||
			typeof item.receipt !== "string"
		)
			return blocked("Malformed finding or unknown requirement");
		const receipt = receipts.get(item.receipt);
		if (
			!receipt ||
			receipt.toolName !== "bash" ||
			!receipt.command ||
			!(
				receipt.status === "error" ||
				receipt.testOutcome === "failed" ||
				(receipt.exitCode !== undefined && receipt.exitCode !== 0)
			)
		)
			return blocked("A reported failure has no failed executable receipt");
		findings.push({ check: item.check, description: item.description, receipt: item.receipt });
	}
	if (data.verdict === "issues")
		return findings.length > 0 ? { status: "issues", findings } : blocked("Issues verdict has no reproduced failure");
	if (findings.length > 0) return blocked("Clean verdict contradicts reproduced failures");
	for (const check of checks) {
		const hasProof = data.evidence.some(item => {
			if (!isRecord(item) || item.check !== check.id || typeof item.receipt !== "string") return false;
			const receipt = receipts.get(item.receipt);
			return (
				receipt?.toolName === "bash" &&
				receipt.status === "ok" &&
				(receipt.exitCode === undefined || receipt.exitCode === 0) &&
				receipt.testOutcome === "passed"
			);
		});
		if (!hasProof) return blocked(`No passing executable evidence for ${check.id}`);
	}
	return { status: "clean", findings: [] };
}

/** Request-scoped, persisted limit. A cancelled or crashed attempt still consumes a slot. */
export class ExecutableReviews {
	constructor(
		private readonly manager: Pick<SessionManager, "getBranch" | "appendCustomEntry">,
		private readonly contracts: VerificationContracts,
		private readonly cwd: string,
	) {}
	#attempts(request: string): Array<{ id?: string }> {
		return this.manager
			.getBranch()
			.flatMap(entry =>
				entry.type === "custom" &&
				entry.customType === ATTEMPT &&
				isRecord(entry.data) &&
				entry.data.request === request
					? [{ id: typeof entry.data.id === "string" ? entry.data.id : undefined }]
					: [],
			);
	}
	#assertAvailable(request: string): void {
		if (this.#attempts(request).length >= 2)
			throw new Error("Independent review limit reached (2 attempts per user request); report unresolved blockers");
	}
	#owns(ticket: ReviewTicket): boolean {
		return (
			this.contracts.requestId === ticket.request &&
			sameChecks(ticket.checks, this.contracts.definition) &&
			this.#attempts(ticket.request).some(attempt => attempt.id === ticket.id)
		);
	}
	async status(): Promise<ExecutableReviewStatus> {
		const request = this.contracts.requestId;
		const branch = this.manager.getBranch();
		const attempts = this.#attempts(request);
		const count = attempts.length;
		const attemptId = attempts.at(-1)?.id;
		const latest = branch.findLast(
			entry =>
				entry.type === "custom" &&
				entry.customType === REPORT &&
				isRecord(entry.data) &&
				entry.data.id === attemptId &&
				entry.data.request === request,
		);
		if (latest?.type !== "custom" || !isRecord(latest.data) || !isRecord(latest.data.report))
			return { attempts: count };
		const data = latest.data;
		const state = await this.contracts.snapshot();
		const checks = state.checks;
		if (
			!state.current ||
			state.requestId !== request ||
			this.contracts.requestId !== request ||
			this.#attempts(request).at(-1)?.id !== attemptId
		)
			return { attempts: this.#attempts(this.contracts.requestId).length };
		const current = state.revisions;
		const snapshot =
			isRecord(data.revisions) && Object.values(data.revisions).every(value => typeof value === "string")
				? (data.revisions as Record<string, string>)
				: null;
		let priorChecks: VerificationCheck[];
		try {
			priorChecks = normalizeVerificationChecks(data.checks, this.cwd);
		} catch {
			return {
				attempts: count,
				report: { status: "blocked", findings: [], reason: "Stored review requirements are invalid" },
			};
		}
		if (!sameChecks(priorChecks, checks) || checks.some(check => check.status !== "passed"))
			return {
				attempts: count,
				report: {
					status: "stale",
					findings: [],
					reason: "Acceptance requirements or evidence changed after review",
				},
			};
		const stored = data.report;
		if (
			!isRecord(stored) ||
			!["clean", "issues", "blocked", "stale"].includes(String(stored.status)) ||
			!Array.isArray(stored.findings)
		)
			return {
				attempts: count,
				report: { status: "blocked", findings: [], reason: "Stored review report is invalid" },
			};
		const report = stored as unknown as ExecutableReviewReport;
		// Revalidation can repair an environmental failure without editing source.
		// Keep successful reviews reusable; refresh findings after new passing runs.
		if (
			report.status === "issues" &&
			Array.isArray(data.checks) &&
			data.checks.some(
				prior =>
					!isRecord(prior) ||
					!checks.some(check => check.id === prior.id && check.evidenceId === prior.evidenceId),
			)
		)
			return {
				attempts: count,
				report: {
					status: "stale",
					findings: [],
					reason: "Acceptance checks were rerun after the reported failures",
				},
			};
		return {
			attempts: count,
			report: sameVerificationRevisions(snapshot, current)
				? report
				: { status: "stale", findings: [], reason: "Files changed after review" },
		};
	}
	async begin(): Promise<ReviewTicket> {
		const request = this.contracts.requestId;
		this.#assertAvailable(request);
		const snapshot = await this.contracts.snapshot();
		const checks = snapshot.checks;
		if (
			!snapshot.current ||
			snapshot.requestId !== request ||
			this.contracts.requestId !== request ||
			!sameChecks(checks, this.contracts.definition)
		)
			throw new Error("Acceptance request or evidence changed during review preflight");
		if (!checks.length || checks.some(check => check.status !== "passed"))
			throw new Error("Pass every acceptance check before requesting independent review");
		if (!snapshot.revisions) throw new Error("Cannot snapshot review files");
		// Check and reserve after the final await: concurrent controllers share the
		// journal, so only two can append an attempt even when all start together.
		this.#assertAvailable(request);
		const ticket = { id: Snowflake.next(), request, checks, revisions: snapshot.revisions };
		this.manager.appendCustomEntry(ATTEMPT, ticket);
		return ticket;
	}
	async finish(ticket: ReviewTicket, report: ExecutableReviewReport): Promise<ExecutableReviewReport> {
		const snapshot = await this.contracts.snapshot();
		if (!this.#owns(ticket) || snapshot.requestId !== ticket.request)
			return { status: "stale", findings: [], reason: "Request or branch changed during review" };
		const settled =
			snapshot.current &&
			snapshot.checks.every(check => check.status === "passed") &&
			sameVerificationRevisions(ticket.revisions, snapshot.revisions)
				? report
				: {
						status: "stale" as const,
						findings: [],
						reason: "Files or acceptance evidence changed during review; rerun checks",
					};
		this.manager.appendCustomEntry(REPORT, { ...ticket, report: settled });
		return settled;
	}
}
