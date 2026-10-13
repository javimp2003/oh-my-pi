import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseSessionEntries } from "@oh-my-pi/pi-coding-agent";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";
import { rejectionOf } from "./helpers/rejection";

function userTexts(messages: Array<{ role: string; content?: unknown }>): string[] {
	return messages.flatMap(message => {
		if (message.role !== "user") return [];
		const content = message.content;
		if (typeof content === "string") return [content];
		if (!Array.isArray(content)) return [];
		return [
			content
				.map(part =>
					part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "",
				)
				.join(""),
		];
	});
}

describe("RPC navigate_tree", () => {
	let client: RpcClient;
	let directory: string;

	beforeEach(async () => {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-navigate-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "fork-rpc-agent.ts")],
			cwd: directory,
			env: { PI_CODING_AGENT_DIR: directory, PI_NO_TITLE: "1" },
		});
	});

	afterEach(async () => {
		await client?.stop();
		await removeWithRetries(directory);
	});

	/** Two finished turns; returns the [user, assistant, user, assistant] message entry ids. */
	async function seedTwoTurns(): Promise<string[]> {
		await client.start();
		await client.promptAndWait("first");
		await client.promptAndWait("second");
		const { entries } = await client.getEntries();
		const messageIds = entries.flatMap(entry => (entry.type === "message" ? [entry.id] : []));
		expect(messageIds).toHaveLength(4);
		return messageIds;
	}

	test("rewinding to an earlier prompt drops later turns from the live session but keeps them in the file", async () => {
		const [firstUser, firstReply, secondUser, secondReply] = await seedTwoTurns();
		const source = await client.getState();

		expect(await client.navigateTree(firstUser)).toEqual({ cancelled: false, editorText: "first" });

		const state = await client.getState();
		expect(state.sessionFile).toBe(source.sessionFile);
		expect(state.messageCount).toBe(0);

		// The edited prompt continues from the rewound point on a new branch of the same file.
		await client.promptAndWait("first, edited");
		expect(userTexts(await client.getMessages())).toEqual(["first, edited"]);
		const entries = parseSessionEntries(await Bun.file(source.sessionFile!).text());
		const messageIds = entries.flatMap(entry => (entry.type === "message" ? [entry.id] : []));
		expect(messageIds.slice(0, 4)).toEqual([firstUser, firstReply, secondUser, secondReply]);
		expect(messageIds).toHaveLength(6);
	}, 30_000);

	test("rewinding to the last prompt resends it from the same point", async () => {
		const [, , secondUser] = await seedTwoTurns();

		expect(await client.navigateTree(secondUser)).toEqual({ cancelled: false, editorText: "second" });
		expect((await client.getState()).messageCount).toBe(2);

		await client.promptAndWait("second, edited");
		expect(userTexts(await client.getMessages())).toEqual(["first", "second, edited"]);
	}, 30_000);

	test("rejects unknown entries and leaves the session as it was", async () => {
		await seedTwoTurns();

		expect(await rejectionOf(client.navigateTree("no-such-entry"))).toMatchObject({
			message: expect.stringMatching(/not found/),
		});
		expect((await client.getState()).messageCount).toBe(4);
	}, 30_000);

	test("refuses while a turn is streaming", async () => {
		const [firstUser] = await seedTwoTurns();
		const idle = Promise.withResolvers<void>();
		const unsubscribe = client.onEvent(event => {
			if (event.type === "agent_end") idle.resolve();
		});
		try {
			await client.prompt("slow");
			expect(await rejectionOf(client.navigateTree(firstUser))).toMatchObject({
				command: "navigate_tree",
				code: "session_busy",
			});
			await withTimeout(idle.promise, 10_000, "Streaming turn did not finish");
		} finally {
			unsubscribe();
		}
		expect((await client.getState()).messageCount).toBe(6);
	}, 30_000);
});
