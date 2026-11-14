import { describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "../../src/config/settings";
import { ExecutionBudget, SessionExecutionBudget } from "../../src/session/execution-budget";
import { SessionManager } from "../../src/session/session-manager";

const usage = { input: 100, output: 20, cacheWrite: 10, cacheRead: 10000 };
const model = buildModel({
	id: "mock",
	name: "mock",
	provider: "custom",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 1024,
});
function agent() {
	let requests = 0;
	const mock = createMockModel({ handler: { content: ["done"], usage: { output: 60 } } });
	const instance = new Agent({
		initialState: { model },
		getApiKey: () => "key",
		streamFn: (model, context, options) => {
			requests++;
			return mock.stream(model, context, options);
		},
	});
	return { instance, requests: () => requests };
}
describe("shared execution budget", () => {
	it("counts uncached prefill and generation once, reserves verification, and enforces wall-clock expiration", () => {
		let now = 0;
		const budget = new ExecutionBudget(
			{ tokens: 100, prefillWeight: 0.5, reservePercent: 30, maxSeconds: 10 },
			() => now,
		);
		budget.record("root:1", usage);
		budget.record("root:1", usage);
		expect(budget.status().spent).toBe(75);
		expect(() => budget.assertSpawn()).toThrow("reserve");
		budget.assertSpawn("verification");
		now = 10_000;
		expect(budget.status().phase).toBe("exhausted");
		expect(() => budget.assertSpawn("verification")).toThrow("exhausted");
	});
	it("reserves time for verification even when there is no token limit", () => {
		let now = 0;
		const budget = new ExecutionBudget(
			{ tokens: 0, prefillWeight: 0, reservePercent: 20, maxSeconds: 10 },
			() => now,
		);
		now = 8000;
		expect(budget.status().phase).toBe("reserve");
		expect(() => budget.assertSpawn()).toThrow("reserve");
		budget.assertSpawn("verification");
		now = 10000;
		expect(budget.status().phase).toBe("exhausted");
	});
	it("charges a late response to its originating request after the next request gets a budget", async () => {
		const settings = Settings.isolated({ "execution.budgetTokens": 300, "execution.prefillWeight": 0 });
		const { promise: started, resolve: markStarted } = Promise.withResolvers<void>();
		const { promise: released, resolve: release } = Promise.withResolvers<void>();
		const mock = createMockModel({
			handler: async () => {
				markStarted();
				await released;
				return { content: ["old request done"], usage: { output: 60 } };
			},
		});
		const instance = new Agent({ initialState: { model }, getApiKey: () => "key", streamFn: mock.stream });
		const controller = new SessionExecutionBudget(
			settings,
			undefined,
			instance,
			SessionManager.inMemory("/tmp"),
			() => {},
		);
		const old = controller.current;
		const running = instance.prompt("old request");
		try {
			await started;
			controller.resetRequest();
			release();
			await running;
			expect(old?.status().spent).toBe(60);
			expect(controller.current?.status().spent).toBe(0);
		} finally {
			release();
			await running;
			controller.dispose();
		}
	});

	it("shares observed parent/child consumption and prevents another actual provider call at exhaustion", async () => {
		const settings = Settings.isolated({ "execution.budgetTokens": 100, "execution.prefillWeight": 0 });
		const parent = agent();
		const child = agent();
		const root = new SessionExecutionBudget(
			settings,
			undefined,
			parent.instance,
			SessionManager.inMemory("/tmp"),
			() => {},
		);
		const leaf = new SessionExecutionBudget(
			settings,
			root.current,
			child.instance,
			SessionManager.inMemory("/tmp"),
			() => {},
		);
		try {
			await parent.instance.prompt("first");
			await child.instance.prompt("second");
			expect(root.current?.status().spent).toBe(120);
			await parent.instance.prompt("third");
			expect(parent.requests()).toBe(1);
			expect(child.requests()).toBe(1);
			const oldLease = leaf.current;
			root.resetRequest();
			expect(root.current?.status().spent).toBe(0);
			expect(oldLease?.status().phase).toBe("exhausted");
			await child.instance.prompt("still old");
			expect(child.requests()).toBe(1);
			await parent.instance.prompt("new request");
			expect(parent.requests()).toBe(2);
			expect(oldLease?.status().spent).toBe(120);
		} finally {
			root.dispose();
			leaf.dispose();
		}
	});
	it("charges new calls after a parked child is rebound to the same session identity", async () => {
		const settings = Settings.isolated({ "execution.budgetTokens": 300, "execution.prefillWeight": 0 });
		const child = agent();
		const manager = SessionManager.inMemory("/tmp");
		const budget = new ExecutionBudget({ tokens: 300, prefillWeight: 0, reservePercent: 20, maxSeconds: 0 });
		const first = new SessionExecutionBudget(settings, budget, child.instance, manager, () => {});
		await child.instance.prompt("first run");
		first.dispose();
		const revived = new SessionExecutionBudget(settings, budget, child.instance, manager, () => {});
		try {
			await child.instance.prompt("revived run");
			expect(budget.status().spent).toBe(120);
		} finally {
			revived.dispose();
		}
	});

	it("emits the reserve notice once without changing the system/tool prefix or duplicating messages", async () => {
		const settings = Settings.isolated({
			"execution.budgetTokens": 200,
			"execution.prefillWeight": 0,
			"execution.reservePercent": 70,
		});
		const parent = agent();
		let notices = 0;
		const manager = SessionManager.inMemory("/tmp");
		const controller = new SessionExecutionBudget(settings, undefined, parent.instance, manager, () => notices++);
		try {
			await parent.instance.prompt("first");
			await parent.instance.prompt("second");
			await parent.instance.prompt("third");
			expect(notices).toBe(1);
			expect(parent.instance.state.messages.filter(message => message.role === "developer")).toHaveLength(1);
			expect(
				manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "developer"),
			).toHaveLength(1);
		} finally {
			controller.dispose();
		}
	});
});
