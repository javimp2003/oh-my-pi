import { isRecord } from "@oh-my-pi/pi-utils";
import {
	createCompactionSummaryMessage,
	type CompactionSummaryMessage,
	type CompactionSummaryMessageOptions,
} from "./messages";

export interface CompactionSummaryBlock {
	summary: string;
	timestamp: string;
	tokensBefore: number;
}

export interface CompactionSummaryChain {
	version: 1;
	blocks: CompactionSummaryBlock[];
}

/** Journal validation ceilings, independent of a session's lower generation budgets. */
const MAX_STORED_BLOCKS = 32;
const MAX_STORED_BYTES = 1024 * 1024;

/** Read only complete, internally consistent chains; stale hook metadata falls back to the entry text. */
export function getCompactionSummaryChain(
	preserveData: Record<string, unknown> | undefined,
	summary: string,
): CompactionSummaryChain | undefined {
	const value = preserveData?.summaryChain;
	if (
		!isRecord(value) ||
		value.version !== 1 ||
		!Array.isArray(value.blocks) ||
		value.blocks.length === 0 ||
		value.blocks.length > MAX_STORED_BLOCKS
	)
		return undefined;
	const blocks: CompactionSummaryBlock[] = [];
	let bytes = 0;
	for (const block of value.blocks) {
		if (
			!isRecord(block) ||
			typeof block.summary !== "string" ||
			!block.summary.trim() ||
			typeof block.timestamp !== "string" ||
			!Number.isFinite(Date.parse(block.timestamp)) ||
			typeof block.tokensBefore !== "number" ||
			!Number.isFinite(block.tokensBefore) ||
			block.tokensBefore < 0
		)
			return undefined;
		bytes += Buffer.byteLength(block.summary);
		if (bytes > MAX_STORED_BYTES) return undefined;
		blocks.push({ summary: block.summary, timestamp: block.timestamp, tokensBefore: block.tokensBefore });
	}
	if (joinCompactionSummaryBlocks(blocks) !== summary) return undefined;
	return { version: 1, blocks };
}

/** Aggregate text remains readable to exports, legacy consumers and other compaction methods. */
export function joinCompactionSummaryBlocks(blocks: readonly CompactionSummaryBlock[]): string {
	return blocks.map(block => block.summary).join("\n\n");
}

export function stripCompactionSummaryChain(
	preserveData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
	if (!preserveData || !Object.hasOwn(preserveData, "summaryChain")) return preserveData;
	const { summaryChain: _chain, ...rest } = preserveData;
	return Object.keys(rest).length ? rest : undefined;
}

/** Replay sealed summaries as separate messages, keeping every earlier message byte-identical. */
export function createCompactionContextMessages(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	preserveData: Record<string, unknown> | undefined,
	options: CompactionSummaryMessageOptions = {},
): CompactionSummaryMessage[] {
	const chain =
		!options.providerPayload && !options.blocks && !options.images && options.method !== "handoff"
			? getCompactionSummaryChain(preserveData, summary)
			: undefined;
	if (!chain) return [createCompactionSummaryMessage(summary, tokensBefore, timestamp, options)];
	return chain.blocks.map(block => createCompactionSummaryMessage(block.summary, block.tokensBefore, block.timestamp));
}
