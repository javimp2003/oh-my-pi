/** Request-scoped acceptance checks backed by observed executions and file revisions. */
import * as path from "node:path";
import { isEnoent, isRecord, Snowflake } from "@oh-my-pi/pi-utils";
import { confineToWorkspace, resolveToCwd } from "../tools/path-utils";
import type { SessionManager } from "./session-manager";

export interface VerificationCheck {
	id: string;
	requirement: string;
	command: string;
	cwd?: string;
	paths: string[];
}
export interface VerificationCheckStatus extends VerificationCheck {
	status: "pending" | "passed" | "failed" | "stale";
	toolCallId?: string;
	evidenceId?: string;
}
export interface VerificationSnapshot {
	requestId: string;
	checks: VerificationCheckStatus[];
	revisions: Record<string, string> | null;
	current: boolean;
}
interface Contract {
	id: string;
	request: string;
	checks: VerificationCheck[];
}
interface Evidence {
	contract: string;
	check: string;
	toolCallId: string;
	passed: boolean;
	revisions: Record<string, string> | null;
	evidenceId?: string;
}
interface PendingCheck {
	contract: string;
	checks: VerificationCheck[];
	revisions: Record<string, string> | null;
}
const CONTRACT_TYPE = "verification-contract";
const EVIDENCE_TYPE = "verification-evidence";
const MAX_CHECKS = 24;
const MAX_PATHS = 128;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;

/** Validate the SDK boundary too: tool schemas are not the only callers. */
export function normalizeVerificationChecks(value: unknown, cwd: string): VerificationCheck[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CHECKS)
		throw new Error("Define 1–24 verification checks");
	const ids = new Set<string>();
	const paths = new Set<string>();
	return value.map(row => {
		if (
			!isRecord(row) ||
			typeof row.id !== "string" ||
			!row.id.trim() ||
			row.id.length > 80 ||
			typeof row.requirement !== "string" ||
			!row.requirement.trim() ||
			row.requirement.length > 2000 ||
			typeof row.command !== "string" ||
			!row.command.trim() ||
			row.command.length > 4096 ||
			!Array.isArray(row.paths) ||
			row.paths.length === 0
		)
			throw new Error("Each check needs an id, requirement, command and workspace file paths");
		const id = row.id.trim();
		if (ids.has(id)) throw new Error(`Duplicate verification check: ${id}`);
		ids.add(id);
		let commandCwd: string | undefined;
		if (row.cwd !== undefined) {
			if (typeof row.cwd !== "string" || !row.cwd.trim())
				throw new Error("Verification cwd must be a workspace directory");
			commandCwd = path.relative(cwd, resolveToCwd(row.cwd, cwd)) || ".";
			if (commandCwd !== "." && !confineToWorkspace(commandCwd, cwd))
				throw new Error("Verification cwd must stay inside the workspace");
		}
		const files = row.paths.map((file: unknown) => {
			if (typeof file !== "string" || !confineToWorkspace(file, cwd))
				throw new Error("Verification paths must name files inside the workspace");
			const normalized = path.relative(cwd, path.resolve(cwd, file));
			paths.add(normalized);
			if (paths.size > MAX_PATHS) throw new Error("Verification contracts support at most 128 distinct files");
			return normalized;
		});
		return {
			id,
			requirement: row.requirement.trim(),
			command: row.command.trim(),
			...(commandCwd ? { cwd: commandCwd } : {}),
			paths: [...new Set(files)],
		};
	});
}

/** One bounded file snapshot; missing files are a meaningful revision (e.g. deletion checks). */
export async function verificationRevisions(
	cwd: string,
	paths: readonly string[],
): Promise<Record<string, string> | null> {
	const result = new Map<string, string>();
	let bytes = 0;
	for (const name of new Set(paths)) {
		const absolute = confineToWorkspace(name, cwd);
		if (!absolute) return null;
		const file = Bun.file(absolute);
		try {
			const stat = await file.stat();
			bytes += stat.size;
			if (!stat.isFile() || bytes > MAX_SNAPSHOT_BYTES) return null;
			// A file can grow between stat and read. Bound the read too, rather than
			// allocating an arbitrarily large buffer before noticing the change.
			const content = await file.slice(0, stat.size + 1).arrayBuffer();
			if (content.byteLength !== stat.size) return null;
			result.set(name, Bun.hash(content).toString(16));
		} catch (error) {
			if (!isEnoent(error)) return null;
			result.set(name, "missing");
		}
	}
	return Object.fromEntries(result);
}
export function sameVerificationRevisions(
	left: Record<string, string> | null,
	right: Record<string, string> | null,
): boolean {
	return (
		left !== null &&
		right !== null &&
		Object.keys(left).length === Object.keys(right).length &&
		Object.entries(left).every(([name, hash]) => right[name] === hash)
	);
}

export class VerificationContracts {
	readonly #pending = new Map<string, PendingCheck>();
	#settling: Promise<void> = Promise.resolve();
	constructor(private readonly manager: SessionManager) {}

	#request(): string {
		for (const entry of this.manager.getBranch().toReversed()) {
			if (entry.type === "reset_boundary") break;
			if (
				entry.type === "message" &&
				entry.message.role === "user" &&
				!entry.message.synthetic &&
				entry.message.attribution !== "agent"
			)
				return entry.id;
		}
		return `initial:${this.manager.getSessionId()}`;
	}
	#contract(): Contract | undefined {
		const request = this.#request();
		for (const entry of this.manager.getBranch().toReversed()) {
			if (entry.type === "reset_boundary") break;
			if (entry.type !== "custom" || entry.customType !== CONTRACT_TYPE || !isRecord(entry.data)) continue;
			const data = entry.data;
			if (data.request !== request || typeof data.id !== "string") continue;
			try {
				return { id: data.id, request, checks: normalizeVerificationChecks(data.checks, this.manager.getCwd()) };
			} catch {
				return undefined;
			}
		}
		return undefined;
	}
	get requestId(): string {
		return this.#request();
	}
	get definition(): VerificationCheck[] {
		return this.#contract()?.checks ?? [];
	}
	define(checks: unknown): void {
		const normalized = normalizeVerificationChecks(checks, this.manager.getCwd());
		const current = this.#contract();
		// Append-only requirements within a request: a retry cannot silently erase an obligation.
		for (const prior of current?.checks ?? []) {
			if (!normalized.some(check => JSON.stringify(check) === JSON.stringify(prior)))
				throw new Error(
					`Keep existing verification check ${prior.id}; start a new user request to replace its contract`,
				);
		}
		if (current && JSON.stringify(current.checks) === JSON.stringify(normalized)) return;
		this.manager.appendCustomEntry(CONTRACT_TYPE, {
			id: current?.id ?? Snowflake.next(),
			request: this.#request(),
			checks: normalized,
		});
	}

	/** Awaited before tool execution, including extension-rewritten command arguments. */
	async begin(toolCallId: string, command: string, signal?: AbortSignal, cwd?: string): Promise<void> {
		const contract = this.#contract();
		const checks =
			contract?.checks.filter(
				check =>
					check.command === command.trim() &&
					path.resolve(this.manager.getCwd(), check.cwd ?? ".") ===
						(cwd ? resolveToCwd(cwd, this.manager.getCwd()) : this.manager.getCwd()),
			) ?? [];
		if (!contract || checks.length === 0) return;
		const snapshot = await verificationRevisions(
			this.manager.getCwd(),
			checks.flatMap(check => check.paths),
		);
		signal?.throwIfAborted();
		this.#pending.set(toolCallId, { contract: contract.id, checks, revisions: snapshot });
	}

	/** Serializes persistence while the session event handler remains synchronous. */
	finish(toolCallId: string, passed: boolean): void {
		const pending = this.#pending.get(toolCallId);
		this.#pending.delete(toolCallId);
		if (!pending) return;
		this.#settling = this.#settling.then(async () => {
			if (this.#contract()?.id !== pending.contract) return;
			const after = await verificationRevisions(
				this.manager.getCwd(),
				pending.checks.flatMap(check => check.paths),
			);
			if (this.#contract()?.id !== pending.contract) return;
			for (const check of pending.checks) {
				const evidence: Evidence = {
					contract: pending.contract,
					check: check.id,
					toolCallId,
					passed: passed && sameVerificationRevisions(pending.revisions, after),
					revisions: after,
				};
				this.manager.appendCustomEntry(EVIDENCE_TYPE, evidence);
			}
		});
	}
	async status(): Promise<VerificationCheckStatus[]> {
		const snapshot = await this.snapshot();
		if (snapshot.requestId !== this.requestId) return [];
		return snapshot.current ? snapshot.checks : snapshot.checks.map(check => ({ ...check, status: "stale" }));
	}
	/** Checks and file revisions from the same read, fenced against concurrent journal changes. */
	async snapshot(): Promise<VerificationSnapshot> {
		const settling = this.#settling;
		await settling;
		const requestId = this.requestId;
		const contract = this.#contract();
		if (!contract) return { requestId, checks: [], revisions: null, current: true };
		const lastEvidenceId = () =>
			this.manager
				.getBranch()
				.findLast(
					entry =>
						entry.type === "custom" &&
						entry.customType === EVIDENCE_TYPE &&
						isRecord(entry.data) &&
						entry.data.contract === contract.id,
				)?.id;
		const evidenceId = lastEvidenceId();
		const evidence = new Map<string, Evidence>();
		for (const entry of this.manager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== EVIDENCE_TYPE || !isRecord(entry.data)) continue;
			const data = entry.data;
			if (
				data.contract === contract.id &&
				typeof data.check === "string" &&
				typeof data.toolCallId === "string" &&
				typeof data.passed === "boolean"
			) {
				const hashes =
					isRecord(data.revisions) && Object.values(data.revisions).every(hash => typeof hash === "string")
						? (data.revisions as Record<string, string>)
						: null;
				evidence.set(data.check, {
					evidenceId: entry.id,
					contract: contract.id,
					check: data.check,
					toolCallId: data.toolCallId,
					passed: data.passed,
					revisions: hashes,
				});
			}
		}
		const current = await verificationRevisions(
			this.manager.getCwd(),
			contract.checks.flatMap(check => check.paths),
		);
		const checks: VerificationCheckStatus[] = contract.checks.map(check => {
			const proof = evidence.get(check.id);
			const unchanged =
				proof?.revisions !== null &&
				proof?.revisions !== undefined &&
				current !== null &&
				check.paths.every(name => proof.revisions?.[name] === current[name]);
			return {
				...check,
				status: !proof ? "pending" : !unchanged ? "stale" : proof.passed ? "passed" : "failed",
				toolCallId: proof?.toolCallId,
				evidenceId: proof?.evidenceId,
			};
		});
		const active = this.#contract();
		return {
			requestId,
			checks,
			revisions: current,
			current:
				this.#settling === settling &&
				this.requestId === requestId &&
				active?.id === contract.id &&
				JSON.stringify(active.checks) === JSON.stringify(contract.checks) &&
				evidenceId === lastEvidenceId(),
		};
	}
}
