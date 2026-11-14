import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import {
	type CompactionPreparation,
	createFileOps,
	DEFAULT_COMPACTION_SETTINGS,
	getCompactionSummaryChain,
} from "@oh-my-pi/pi-agent-core/compaction";
import { TempDir } from "@oh-my-pi/pi-utils";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { SessionProviderBoundary, type SessionProviderBoundaryHost } from "../../src/session/session-provider-boundary";
import { SecretObfuscator } from "../../src/secrets/obfuscator";

const firstBlock = { summary: "Keep PROJ-12", timestamp: "2026-11-01T00:00:00.000Z", tokensBefore: 100 };
const secondBlock = { summary: "Now implement PROJ-13", timestamp: "2026-11-02T00:00:00.000Z", tokensBefore: 200 };

describe("summary chain context", () => {
	it("replays sealed prefixes after resume and isolates branch navigation and clear", async () => {
		const temp = TempDir.createSync("@omp-summary-chain-");
		let manager = SessionManager.create(temp.path(), path.join(temp.path(), "sessions"));
		try {
			await manager.ensureOnDisk();
			const old = manager.appendMessage({ role: "user", content: "old history", timestamp: 1 });
			const kept = manager.appendMessage({ role: "user", content: "recent", timestamp: 2 });
			const first = manager.appendCompaction(firstBlock.summary, undefined, kept, 100, {
				method: "incremental",
				preserveData: { summaryChain: { version: 1, blocks: [firstBlock] } },
			});
			const prefix = convertToLlm(manager.buildSessionContext().messages).slice(0, 1);
			const newKept = manager.appendMessage({ role: "user", content: "continue", timestamp: 3 });
			const summary = firstBlock.summary + "\n\n" + secondBlock.summary;
			const latest = manager.appendCompaction(summary, undefined, newKept, 200, {
				method: "incremental",
				preserveData: { summaryChain: { version: 1, blocks: [firstBlock, secondBlock] } },
			});
			const beforeResume = convertToLlm(manager.buildSessionContext().messages);
			expect(beforeResume.slice(0, 1)).toEqual(prefix);
			expect(beforeResume).toHaveLength(3);
			expect(JSON.stringify(beforeResume)).not.toContain("old history");
			expect(JSON.stringify(beforeResume)).not.toContain('"recent"');
			await manager.flush();
			const file = manager.getSessionFile()!;
			await manager.close();
			manager = await SessionManager.open(file);
			expect(convertToLlm(manager.buildSessionContext().messages)).toEqual(beforeResume);
			manager.branch(first);
			expect(convertToLlm(manager.buildSessionContext().messages).slice(0, 1)).toEqual(prefix);
			expect(JSON.stringify(manager.buildSessionContext().messages)).not.toContain("PROJ-13");
			manager.branch(old);
			expect(manager.buildSessionContext().messages.some(message => message.role === "compactionSummary")).toBe(
				false,
			);
			manager.branch(latest);
			const transcript = manager.buildSessionContext({ transcript: true, collapseCompactedHistory: true });
			expect(transcript.messages.filter(message => message.role === "compactionSummary")).toHaveLength(1);
			manager.appendResetBoundary();
			manager.appendMessage({ role: "user", content: "fresh conversation", timestamp: 4 });
			expect(convertToLlm(manager.buildSessionContext().messages).map(message => message.content)).toEqual([
				"fresh conversation",
			]);
		} finally {
			await manager.close();
			temp.removeSync();
		}
	});

	it("redacts each sealed block without losing the chain or leaking a secret into a side request", () => {
		const secret = "private-ticket-token";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const boundary = new SessionProviderBoundary({
			obfuscator: () => obfuscator,
		} as unknown as SessionProviderBoundaryHost);
		const block = { ...firstBlock, summary: `Use ${secret}` };
		const preparation: CompactionPreparation = {
			firstKeptEntryId: "kept",
			messagesToSummarize: [],
			turnPrefixMessages: [],
			recentMessages: [],
			isSplitTurn: false,
			tokensBefore: 100,
			fileOps: createFileOps(),
			settings: DEFAULT_COMPACTION_SETTINGS,
			previousSummary: block.summary,
			previousPreserveData: { summaryChain: { version: 1, blocks: [block] } },
		};
		const redacted = boundary.obfuscateCompactionPreparation(preparation);
		expect(JSON.stringify(redacted)).not.toContain(secret);
		expect(getCompactionSummaryChain(redacted.previousPreserveData, redacted.previousSummary!)?.blocks).toHaveLength(
			1,
		);
		expect(preparation.previousSummary).toContain(secret);
	});
});
