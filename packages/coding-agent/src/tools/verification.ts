import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolResult } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import { ExecutableReviews, auditExecutableReview } from "../session/executable-review";
import { runStructuredSubagent } from "../task/structured-subagent";
import reviewAssignment from "../prompts/system/executable-review-assignment.md" with { type: "text" };
import type { ExecutableReviewReport } from "../session/executable-review";
import description from "../prompts/tools/verification.md" with { type: "text" };
import type { VerificationCheckStatus } from "../session/verification-contract";
import type { ToolSession } from ".";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";

const schema = type({
	op: '"define" | "status" | "review"',
	"checks?": type({
		id: "string",
		requirement: "string",
		command: "string",
		"cwd?": "string",
		paths: "string[]",
	}).array(),
});
interface VerificationDetails {
	checks: VerificationCheckStatus[];
	review?: ExecutableReviewReport;
	reviewAttempts?: number;
}

export class VerificationTool implements AgentTool<typeof schema, VerificationDetails> {
	readonly name = "verification";
	readonly label = "Verification";
	readonly description = prompt.render(description);
	readonly parameters = schema;
	readonly loadMode = "discoverable";
	readonly concurrency = "exclusive";
	readonly approval = "read" as const;
	constructor(private readonly session: ToolSession) {}
	async execute(
		_id: string,
		args: typeof schema.infer,
		signal?: AbortSignal,
	): Promise<AgentToolResult<VerificationDetails>> {
		signal?.throwIfAborted();
		const ledger = this.session.getVerificationContracts?.();
		if (!ledger) throw new ToolError("Verification contracts are unavailable in this host");
		if (args.op === "define") ledger.define(args.checks);
		const requestId = ledger.requestId;
		const manager = this.session.sessionManager;
		const reviews = manager ? new ExecutableReviews(manager, ledger, this.session.cwd) : undefined;
		if (args.op === "review") {
			if (!manager || !reviews) throw new ToolError("Review requires a session journal");
			const previous = await reviews.status();
			if (previous.report?.status !== "clean" && previous.report?.status !== "issues") {
				const ticket = await reviews.begin();
				try {
					const messages = manager.getBranch();
					const user = messages.find(entry => entry.id === ticket.request);
					const request =
						user?.type === "message" && user.message.role === "user" ? user.message.content : undefined;
					const { result } = await runStructuredSubagent({
						session: this.session,
						budgetPurpose: "verification",
						invocationKind: "task",
						parentToolCallId: _id,
						agent: "verifier",
						assignment: prompt.render(reviewAssignment, {
							checks: ticket.checks,
							request:
								typeof request === "string"
									? request
									: request === undefined
										? undefined
										: JSON.stringify(request),
						}),
						outputSchema: reviewSchema,
						schemaMode: "strict",
						isolation: { requested: false },
						enableIrc: false,
						maxRuntimeMs: 180_000,
						signal,
					});
					await reviews.finish(ticket, auditExecutableReview(result, ticket.checks));
				} catch (error) {
					await reviews.finish(ticket, {
						status: "blocked",
						findings: [],
						reason: error instanceof Error ? error.message : String(error),
					});
					signal?.throwIfAborted();
				}
			}
		}
		let checks = await ledger.status();
		const state = await reviews?.status();
		const changedRequest = ledger.requestId !== requestId;
		if (changedRequest) checks = [];
		// Only the current journal state can certify a result. A cached verdict
		// must never survive a request/branch change while the awaits above run.
		let review = !changedRequest ? state?.report : undefined;
		if (args.op === "review" && !review)
			review = {
				status: "stale",
				findings: [],
				reason: "Request, branch or verification evidence changed before the review result was delivered",
			};
		const details: VerificationDetails = { checks, review, reviewAttempts: changedRequest ? 0 : state?.attempts };
		return { content: [{ type: "text", text: JSON.stringify(details) }], details };
	}
}

const reviewSchema = {
	type: "object",
	required: ["verdict", "reason", "findings", "evidence"],
	additionalProperties: false,
	properties: {
		verdict: { type: "string", enum: ["clean", "issues", "blocked"] },
		reason: { type: "string" },
		findings: {
			type: "array",
			items: {
				type: "object",
				required: ["check", "description", "receipt"],
				properties: { check: { type: "string" }, description: { type: "string" }, receipt: { type: "string" } },
				additionalProperties: false,
			},
		},
		evidence: {
			type: "array",
			items: {
				type: "object",
				required: ["check", "receipt"],
				properties: { check: { type: "string" }, receipt: { type: "string" } },
				additionalProperties: false,
			},
		},
	},
};
