import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { Snowflake } from "@oh-my-pi/pi-utils";
import { isSelfImprovableSkill, type Skill } from "../src/extensibility/skills";
import { SKILL_PROMPT_MESSAGE_TYPE } from "../src/session/messages";
import { listSkillHistory, revertSkillHistoryEntry, writeSkillHistoryEntry } from "../src/skill-curation/history";
import { collectCurationSignals, renderTaskTranscript } from "../src/skill-curation/signals";
import { SkillEditTool } from "../src/skill-curation/skill-edit-tool";

const SKILL_FILE = `---
name: demo
description: Lists the demo folder. Use when the user asks what is in the demo folder.
---

# Demo

To list the demo folder run: \`ls --long-format demo\`
`;

let root = "";

function skillAt(name: string, provider = "native"): Skill {
	const baseDir = path.join(root, "skills", name);
	return {
		name,
		description: "Lists the demo folder.",
		filePath: path.join(baseDir, "SKILL.md"),
		baseDir,
		source: `${provider}:project`,
		_source: { provider, providerName: provider, path: path.join(baseDir, "SKILL.md"), level: "project" },
	};
}

function readCall(id: string, target: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: { path: target } }],
		api: "openai-responses",
		provider: "openai",
		model: "test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 0,
	} as AgentMessage;
}

function toolResult(toolCallId: string, isError: boolean): AgentMessage {
	return { role: "toolResult", toolCallId, toolName: "bash", content: [], isError, timestamp: 0 };
}

beforeEach(async () => {
	root = path.join(os.tmpdir(), "omp-skill-curation", Snowflake.next());
	await Bun.write(path.join(root, "skills", "demo", "SKILL.md"), SKILL_FILE);
	await Bun.write(path.join(root, "skills", "demo", "ref.md"), "reference\n");
});

afterEach(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

describe("collectCurationSignals", () => {
	it("finds a used skill when a tool fails after it is read, and flags a late read", () => {
		const demo = skillAt("demo");
		const afterRead = collectCurationSignals(
			[readCall("r1", "skill://demo"), toolResult("r1", false), toolResult("b1", true)],
			[demo],
			root,
		);
		expect(afterRead).toEqual({ candidates: [{ skill: demo, readLate: false }], errorCount: 1 });

		const lateRead = collectCurationSignals(
			[toolResult("b1", true), readCall("r1", path.join(demo.baseDir, "SKILL.md:1-5")), toolResult("r1", false)],
			[demo],
			root,
		);
		expect(lateRead?.candidates).toEqual([{ skill: demo, readLate: true }]);
	});

	it("needs both a used skill and a failure that is not the skill read itself", () => {
		const demo = skillAt("demo");
		expect(
			collectCurationSignals([readCall("r1", "skill://demo"), toolResult("r1", false)], [demo], root),
		).toBeUndefined();
		// A failing read of the skill file is not a task failure.
		expect(
			collectCurationSignals([readCall("r1", "skill://demo"), toolResult("r1", true)], [demo], root),
		).toBeUndefined();
		// A skill outside the editable set is ignored.
		expect(
			collectCurationSignals([readCall("r1", "skill://other"), toolResult("b1", true)], [demo], root),
		).toBeUndefined();
	});

	it("counts a /skill: invocation as use", () => {
		const demo = skillAt("demo");
		const invoked: AgentMessage = {
			role: "custom",
			customType: SKILL_PROMPT_MESSAGE_TYPE,
			content: "body",
			display: true,
			details: { name: "demo", path: demo.filePath },
			attribution: "user",
			timestamp: 0,
		};
		expect(collectCurationSignals([invoked, toolResult("b1", true)], [demo], root)?.candidates).toEqual([
			{ skill: demo, readLate: false },
		]);
	});
});

describe("isSelfImprovableSkill", () => {
	it("edits other tools' skill folders only when third-party improvement is on; never plugin or registry skills", () => {
		expect(isSelfImprovableSkill(skillAt("demo", "native"), false)).toBe(true);
		expect(isSelfImprovableSkill(skillAt("demo", "claude"), false)).toBe(false);
		expect(isSelfImprovableSkill(skillAt("demo", "claude"), true)).toBe(true);
		expect(isSelfImprovableSkill(skillAt("demo", "claude-plugins"), true)).toBe(false);
		expect(isSelfImprovableSkill(skillAt("demo", "skillshare"), true)).toBe(false);
	});
});

describe("renderTaskTranscript", () => {
	it("shows calls with their results and errors in order, keeping the end when too long", () => {
		const failed: AgentMessage = {
			role: "toolResult",
			toolCallId: "b1",
			toolName: "bash",
			content: [{ type: "text", text: "ls: unrecognized option '--long-format'" }],
			isError: true,
			timestamp: 0,
		};
		const transcript = renderTaskTranscript([readCall("r1", "skill://demo"), failed]);
		expect(transcript).toBe(`CALL read: {"path":"skill://demo"}\nERROR: ls: unrecognized option '--long-format'`);

		const many = Array.from({ length: 400 }, () => failed);
		const long = renderTaskTranscript([readCall("r1", "skill://first"), ...many]);
		expect(long.length).toBeLessThanOrEqual(16_001);
		expect(long.startsWith("…")).toBe(true);
		expect(long.endsWith("--long-format'")).toBe(true);
	});
});

describe("SkillEditTool", () => {
	const edit = (tool: SkillEditTool, params: Partial<Parameters<SkillEditTool["execute"]>[1]>) =>
		tool.execute("call", {
			skill: "demo",
			old_text: "ls --long-format demo",
			new_text: "ls -l demo",
			summary: "Uses ls -l to list the demo folder",
			...params,
		});

	it("applies a unique replacement and records before/after", async () => {
		const demo = skillAt("demo");
		const tool = new SkillEditTool([demo]);
		const result = await edit(tool, {});
		expect(result.isError).toBeUndefined();
		expect(await Bun.file(demo.filePath).text()).toContain("ls -l demo");
		const file = tool.edits.get("demo")?.files.get(demo.filePath);
		expect(file?.before).toBe(SKILL_FILE);
		expect(file?.after).toBe(SKILL_FILE.replace("ls --long-format demo", "ls -l demo"));
	});

	it("rejects ambiguous text, escapes, frontmatter damage and unknown skills without writing", async () => {
		const demo = skillAt("demo");
		const tool = new SkillEditTool([demo]);
		const cases: Array<[Partial<Parameters<SkillEditTool["execute"]>[1]>, string]> = [
			[{ old_text: "demo" }, "occurs"],
			[{ file: "../escape.md" }, "inside the skill directory"],
			[{ old_text: "name: demo", new_text: "name: renamed" }, "name must not change"],
			[
				{
					old_text: "description: Lists the demo folder.",
					new_text: `description: ${"x".repeat(1100)}`,
				},
				"limit is 1024",
			],
			[{ skill: "other" }, "Editable skills: demo"],
		];
		for (const [params, message] of cases) {
			const result = await edit(tool, params);
			expect(result.isError).toBe(true);
			expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(message) });
		}
		expect(await Bun.file(demo.filePath).text()).toBe(SKILL_FILE);
		expect(tool.edits.size).toBe(0);
	});
});

describe("skill history", () => {
	it("reverts an edit once, and refuses when the file changed since", async () => {
		const agentDir = path.join(root, "agent");
		const demo = skillAt("demo");
		const after = SKILL_FILE.replace("ls --long-format demo", "ls -l demo");
		await Bun.write(demo.filePath, after);
		const files = [{ path: demo.filePath, relativePath: "SKILL.md", before: SKILL_FILE, after }];

		const entry = await writeSkillHistoryEntry({ skill: "demo", summary: "Uses ls -l", files }, agentDir);
		const [listed] = await listSkillHistory({ skill: "demo" }, agentDir);
		expect(listed.id).toBe(entry.id);
		expect(listed.diff).toContain("- To list the demo folder run: `ls --long-format demo`");
		expect(listed.diff).toContain("+ To list the demo folder run: `ls -l demo`");

		await revertSkillHistoryEntry(entry.id, agentDir);
		expect(await Bun.file(demo.filePath).text()).toBe(SKILL_FILE);
		await expect(revertSkillHistoryEntry(entry.id, agentDir)).rejects.toThrow("already reverted");

		await Bun.write(demo.filePath, after);
		const second = await writeSkillHistoryEntry({ skill: "demo", summary: "Uses ls -l", files }, agentDir);
		await Bun.write(demo.filePath, `${after}\nEdited by hand.\n`);
		await expect(revertSkillHistoryEntry(second.id, agentDir)).rejects.toThrow("changed since the update: SKILL.md");
		expect(await Bun.file(demo.filePath).text()).toBe(`${after}\nEdited by hand.\n`);
	});
});
