import { afterEach, describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { PLAN_APPROVE_OPTION, PLAN_REFINE_OPTION } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-plan";

type Frame = Record<string, unknown>;

/** RPC child over raw JSONL: commands by id, plus `select` dialogs answered from a queue. */
class PlanRpc {
	readonly #child: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #waiters = new Map<string, (frame: Frame) => void>();
	readonly #frameListeners = new Set<(frame: Frame) => void>();
	readonly selects: Frame[] = [];
	readonly answers: string[] = [];
	#nextId = 0;
	readonly done: Promise<void>;

	constructor(cwd: string) {
		this.#child = Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "plan-rpc-agent.ts")], {
			cwd,
			env: { PATH: Bun.env.PATH, HOME: cwd, PI_CODING_AGENT_DIR: cwd, PI_NO_TITLE: "1", CI: "true" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		this.done = this.#read();
	}

	async #read(): Promise<void> {
		for await (const frame of readJsonl<unknown>(this.#child.stdout)) {
			if (!isRecord(frame)) continue;
			if (frame.type === "response" && typeof frame.id === "string") {
				this.#waiters.get(frame.id)?.(frame);
				this.#waiters.delete(frame.id);
			} else if (frame.type === "extension_ui_request" && frame.method === "select") {
				this.selects.push(frame);
				const value = this.answers.shift();
				this.#write(
					value === undefined
						? { type: "extension_ui_response", id: frame.id, cancelled: true }
						: { type: "extension_ui_response", id: frame.id, value },
				);
			}
			for (const listener of this.#frameListeners) listener(frame);
		}
	}

	#write(frame: object): void {
		this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
		void this.#child.stdin.flush();
	}

	async command(command: Frame): Promise<Frame> {
		const id = `c${++this.#nextId}`;
		const { promise, resolve } = Promise.withResolvers<Frame>();
		this.#waiters.set(id, resolve);
		this.#write({ ...command, id });
		return promise;
	}

	async data(command: Frame): Promise<Frame> {
		const response = await this.command(command);
		if (response.success !== true) throw new Error(String(response.error));
		return response.data as Frame;
	}

	/** Prompt and resolve once the turn's `agent_end` arrives. */
	async promptToEnd(message: string): Promise<void> {
		const { promise, resolve } = Promise.withResolvers<void>();
		const listener = (frame: Frame) => {
			if (frame.type === "agent_end") {
				this.#frameListeners.delete(listener);
				resolve();
			}
		};
		this.#frameListeners.add(listener);
		await this.data({ type: "prompt", message });
		await promise;
	}

	async stop(): Promise<void> {
		this.#child.stdin.end();
		this.#child.kill();
		await this.#child.exited;
	}
}

describe("RPC plan mode", () => {
	let rpc: PlanRpc | undefined;
	let temp: TempDir | undefined;

	afterEach(async () => {
		await rpc?.stop();
		rpc = undefined;
		temp?.removeSync();
		temp = undefined;
	});

	async function start(): Promise<PlanRpc> {
		temp = TempDir.createSync("@omp-rpc-plan-");
		rpc = new PlanRpc(temp.path());
		return rpc;
	}

	test("set_plan_mode toggles the state get_state reports", async () => {
		const client = await start();
		const initial = await client.data({ type: "get_state" });
		expect(initial.planMode).toBeNull();
		expect(initial.planModeAvailable).toBe(true);

		const entered = await client.data({ type: "set_plan_mode", enabled: true });
		expect(entered.planMode).toMatchObject({ enabled: true, planFilePath: "local://PLAN.md" });
		expect((await client.data({ type: "get_state" })).planMode).toEqual(entered.planMode);
		// Entering twice is a no-op, not an error.
		expect((await client.data({ type: "set_plan_mode", enabled: true })).planMode).toEqual(entered.planMode);

		expect((await client.data({ type: "set_plan_mode", enabled: false })).planMode).toBeNull();
		expect((await client.data({ type: "get_state" })).planMode).toBeNull();
	}, 30_000);

	test("approving the proposed plan exits plan mode", async () => {
		const client = await start();
		await client.data({ type: "set_plan_mode", enabled: true });
		client.answers.push(PLAN_APPROVE_OPTION);
		await client.promptToEnd("plan it");

		expect(client.selects).toHaveLength(1);
		expect(client.selects[0]?.options).toEqual([PLAN_APPROVE_OPTION, PLAN_REFINE_OPTION]);
		expect(String(client.selects[0]?.title)).toContain("1. Do the thing.");
		expect((await client.data({ type: "get_state" })).planMode).toBeNull();
	}, 30_000);

	test("refining or dismissing the dialog keeps plan mode on", async () => {
		const client = await start();
		await client.data({ type: "set_plan_mode", enabled: true });
		// Refine the first proposal, dismiss the next ones (no answer queued = cancelled).
		client.answers.push(PLAN_REFINE_OPTION);
		await client.promptToEnd("plan it");

		expect(client.selects.length).toBeGreaterThanOrEqual(1);
		const planMode = (await client.data({ type: "get_state" })).planMode as Record<string, unknown>;
		expect(planMode).toMatchObject({ enabled: true, planFilePath: "local://PLAN.md" });
		// Hosts read the reviewed plan from the resolved on-disk path.
		expect(await Bun.file(String(planMode.planFile)).text()).toContain("1. Do the thing.");
	}, 30_000);

	test("new_session leaves plan mode", async () => {
		const client = await start();
		await client.data({ type: "set_plan_mode", enabled: true });
		await client.data({ type: "new_session" });
		expect((await client.data({ type: "get_state" })).planMode).toBeNull();
	}, 30_000);
});
