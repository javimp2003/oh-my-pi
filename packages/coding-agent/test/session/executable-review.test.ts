import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import type { SingleResult, ToolReceipt } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";
import { auditExecutableReview, ExecutableReviews } from "../../src/session/executable-review";
import * as subagents from "../../src/task/structured-subagent";
import { VerificationTool } from "../../src/tools/verification";
import { Settings } from "../../src/config/settings";
import { SessionManager } from "../../src/session/session-manager";
import { VerificationContracts, type VerificationCheckStatus } from "../../src/session/verification-contract";
const check: VerificationCheckStatus = {
	id: "decode",
	requirement: "decode async data",
	command: "bun test",
	paths: ["a.ts"],
	status: "passed",
};
const pass: ToolReceipt = {
	id: "r1",
	seq: 1,
	toolCallId: "t1",
	toolName: "bash",
	status: "ok",
	command: "bun test",
	testOutcome: "passed",
	at: 1,
};
function result(
	data: unknown,
	receipts: ToolReceipt[] = [pass],
): Pick<SingleResult, "exitCode" | "structuredOutput" | "receipts"> {
	return { exitCode: 0, receipts, structuredOutput: { source: "caller", mode: "strict", status: "valid", data } };
}
const roots: TempDir[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) root.removeSync();
});
async function observedChecks() {
	const root = TempDir.createSync("@omp-review-race-");
	roots.push(root);
	await Bun.write(path.join(root.path(), "a.ts"), "initial");
	const manager = SessionManager.inMemory(root.path());
	manager.appendMessage({ role: "user", content: "decode data", timestamp: 1 });
	const ledger = new VerificationContracts(manager);
	ledger.define([check]);
	await ledger.begin("observed-pass", "bun test");
	ledger.finish("observed-pass", true);
	await ledger.status();
	const reviews = new ExecutableReviews(manager, ledger, root.path());
	const tool = new VerificationTool({
		cwd: root.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		sessionManager: manager,
		getVerificationContracts: () => ledger,
	});
	return { root, manager, ledger, reviews, tool };
}
describe("executable independent review", () => {
	it("enforces the persisted attempt limit across concurrent controllers", async () => {
		const { root, manager, ledger } = await observedChecks();
		const starts = await Promise.allSettled(
			Array.from({ length: 3 }, () => new ExecutableReviews(manager, ledger, root.path()).begin()),
		);
		expect(starts.filter(start => start.status === "fulfilled")).toHaveLength(2);
		expect(starts.filter(start => start.status === "rejected")).toHaveLength(1);
	});
	it("rejects a request that changes while the review preflight is reading its files", async () => {
		const { manager, ledger, reviews } = await observedChecks();
		const status = ledger.snapshot.bind(ledger);
		vi.spyOn(ledger, "snapshot").mockImplementationOnce(async () => {
			const checks = await status();
			manager.appendMessage({ role: "user", content: "different request", timestamp: 2 });
			return checks;
		});
		await expect(reviews.begin()).rejects.toThrow("changed");
		expect((await reviews.status()).attempts).toBe(0);
	});
	it("invalidates a clean review when acceptance checks fail again without a source edit", async () => {
		const { ledger, reviews } = await observedChecks();
		const ticket = await reviews.begin();
		await ledger.begin("later-failure", "bun test");
		ledger.finish("later-failure", false);
		await ledger.status();
		expect((await reviews.finish(ticket, { status: "clean", findings: [] })).status).toBe("stale");
		expect((await reviews.status()).report?.status).toBe("stale");
	});
	it("returns the persisted findings and reuses unchanged reviews instead of spending another child request", async () => {
		const { ledger, reviews, tool } = await observedChecks();
		const ticket = await reviews.begin();
		await reviews.finish(ticket, {
			status: "issues",
			findings: [{ check: "decode", description: "empty input throws", receipt: "r1" }],
		});
		const spawn = vi
			.spyOn(subagents, "runStructuredSubagent")
			.mockRejectedValue(new Error("transient provider failure"));
		const status = await tool.execute("status", { op: "status" });
		expect(status.details?.review?.status).toBe("issues");
		expect((await tool.execute("review-again", { op: "review" })).details?.review?.status).toBe("issues");
		expect(spawn).not.toHaveBeenCalled();
		// Some gateways reuse tool-call ids. Distinguish executions by journal evidence.
		await ledger.begin("observed-pass", "bun test");
		ledger.finish("observed-pass", true);
		await ledger.status();
		expect((await tool.execute("review-repair", { op: "review" })).details?.review?.status).toBe("blocked");
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("does not publish a result onto a branch that discarded the running review", async () => {
		const { manager, reviews } = await observedChecks();
		const branch = manager.getLeafId()!;
		const ticket = await reviews.begin();
		manager.branch(branch);
		expect((await reviews.finish(ticket, { status: "clean", findings: [] })).status).toBe("stale");
		expect((await reviews.status()).attempts).toBe(0);
		const replacement = await reviews.begin();
		await reviews.finish(replacement, { status: "clean", findings: [] });
		expect((await reviews.status()).report?.status).toBe("clean");
	});

	it("keeps a clean review reusable after successful revalidation of identical files", async () => {
		const { ledger, reviews, tool } = await observedChecks();
		const ticket = await reviews.begin();
		await reviews.finish(ticket, { status: "clean", findings: [] });
		await ledger.begin("fresh-success", "bun test");
		ledger.finish("fresh-success", true);
		await ledger.status();
		const spawn = vi.spyOn(subagents, "runStructuredSubagent").mockRejectedValue(new Error("must not dispatch"));
		expect((await tool.execute("cached-clean", { op: "review" })).details?.review?.status).toBe("clean");
		expect((await reviews.status()).attempts).toBe(1);
		expect(spawn).not.toHaveBeenCalled();
	});

	it("does not return a cached clean verdict for a request that changes during the status read", async () => {
		const { ledger, manager, reviews, tool } = await observedChecks();
		const ticket = await reviews.begin();
		await reviews.finish(ticket, { status: "clean", findings: [] });
		const status = ledger.status.bind(ledger);
		vi.spyOn(ledger, "status").mockImplementationOnce(async () => {
			const checks = await status();
			manager.appendMessage({ role: "user", content: "new request", timestamp: 2 });
			return checks;
		});
		const result = await tool.execute("racing-status", { op: "review" });
		expect(result.details?.review?.status).toBe("stale");
		expect(result.details?.checks).toEqual([]);
	});

	it("rejects invented receipts and requires passing evidence for every requirement", () => {
		expect(
			auditExecutableReview(
				result({ verdict: "clean", findings: [], evidence: [{ check: "decode", receipt: "r99" }] }),
				[check],
			).status,
		).toBe("blocked");
		expect(
			auditExecutableReview(
				result({ verdict: "clean", findings: [], evidence: [{ check: "decode", receipt: "r1" }] }),
				[check],
			).status,
		).toBe("clean");
		expect(
			auditExecutableReview(
				result({ verdict: "clean", findings: [], evidence: [{ check: "decode", receipt: "r1" }] }),
				[check, { ...check, id: "encode" }],
			).status,
		).toBe("blocked");
	});
	it("dispatches a fresh verifier, surfaces execution failures and caps retries at the tool boundary", async () => {
		const root = TempDir.createSync("@omp-review-tool-");
		roots.push(root);
		await Bun.write(path.join(root.path(), "a.ts"), "initial");
		const manager = SessionManager.inMemory(root.path());
		manager.appendMessage({ role: "user", content: "decode data", timestamp: 1 });
		const ledger = new VerificationContracts(manager);
		ledger.define([check]);
		await ledger.begin("t1", "bun test");
		ledger.finish("t1", true);
		await ledger.status();
		const tool = new VerificationTool({
			cwd: root.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(),
			sessionManager: manager,
			getVerificationContracts: () => ledger,
		});
		const signal = new AbortController().signal;
		const spawn = vi.spyOn(subagents, "runStructuredSubagent").mockImplementation(async request => {
			expect(request.forkSource).toBeUndefined();
			expect(request.signal).toBe(signal);
			throw new Error("reviewer unavailable");
		});
		const first = await tool.execute("parent-review", { op: "review" }, signal);
		expect(first.details?.review?.status).toBe("blocked");
		await tool.execute("parent-review-2", { op: "review" }, signal);
		await expect(tool.execute("parent-review-3", { op: "review" }, signal)).rejects.toThrow("limit reached");
		expect(spawn).toHaveBeenCalledTimes(2);
	});

	it("requires a real failed command before reporting a reproduced bug", () => {
		const data = {
			verdict: "issues",
			findings: [{ check: "decode", description: "empty input throws", receipt: "r1" }],
			evidence: [],
		};
		expect(auditExecutableReview(result(data), [check]).status).toBe("blocked");
		expect(auditExecutableReview(result(data, [{ ...pass, status: "error", exitCode: 1 }]), [check]).status).toBe(
			"issues",
		);
	});
	it("invalidates reports across edits and persists the retry cap across resumed controllers", async () => {
		const root = TempDir.createSync("@omp-review-");
		roots.push(root);
		await Bun.write(path.join(root.path(), "a.ts"), "initial");
		const manager = SessionManager.inMemory(root.path());
		manager.appendMessage({ role: "user", content: "decode", timestamp: 1 });
		const ledger = new VerificationContracts(manager);
		ledger.define([check]);
		await ledger.begin("t1", "bun test");
		ledger.finish("t1", true);
		await ledger.status();
		const reviews = new ExecutableReviews(manager, ledger, root.path());
		const ticket = await reviews.begin();
		await Bun.write(path.join(root.path(), "a.ts"), "edited");
		expect((await reviews.finish(ticket, { status: "clean", findings: [] })).status).toBe("stale");
		await ledger.begin("t2", "bun test");
		ledger.finish("t2", true);
		await ledger.status();
		await new ExecutableReviews(manager, ledger, root.path()).begin();
		await expect(new ExecutableReviews(manager, ledger, root.path()).begin()).rejects.toThrow("limit reached");
	});
});
