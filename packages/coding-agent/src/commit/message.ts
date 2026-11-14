import type { ConventionalAnalysis } from "./types";
import { formatConventionalCommit } from "./conventional/normalization";
import { type CommitPolicy, validateUnicajaCommit } from "./style";

export function formatCommitMessage(analysis: ConventionalAnalysis, summary: string, policy?: CommitPolicy): string {
	if (policy?.style === "unicaja") {
		const message = {
			type: analysis.type,
			scope: analysis.scope,
			summary,
			body: analysis.details.map(detail => detail.text.trim()),
			footers: [],
			issueKey: policy.issueKey,
		};
		const errors = validateUnicajaCommit(message);
		if (errors.length) throw new Error(errors.join("; "));
		return formatConventionalCommit(message);
	}
	const scopePart = analysis.scope ? `(${analysis.scope})` : "";
	const header = `${analysis.type}${scopePart}: ${summary}`;
	const bodyLines = analysis.details.map(detail => `- ${detail.text.trim()}`);
	if (bodyLines.length === 0) {
		return header;
	}
	return `${header}\n\n${bodyLines.join("\n")}`;
}
