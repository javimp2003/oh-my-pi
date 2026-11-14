import type { BenchmarkSnapshot } from "../src/benchmarks";
import { describe, expect, it } from "bun:test";
import { candidateFromHarbor, selectExecutionProfile, type ProfileCalibration } from "../src/execution-profiles";
function calibration(): ProfileCalibration {
	return {
		split: "development",
		target: { provider: "local", model: "open-model", backend: "vllm+litellm" },
		taskIds: ["a", "b"],
		evaluationTaskIds: ["formal"],
		candidates: [
			{
				id: "cheap",
				settings: { "edit.mode": "replace", "tools.xdevDocs": "catalog" },
				trials: [
					{ task: "a", status: "pass", costUsd: 0.01, durationMs: 10 },
					{ task: "b", status: "timeout", costUsd: 0.01, durationMs: 10 },
				],
			},
			{
				id: "correct",
				settings: { "edit.mode": "hashline", "tools.xdevDocs": "builtins" },
				trials: [
					{ task: "a", status: "pass", costUsd: 1, durationMs: 100 },
					{ task: "b", status: "pass", costUsd: 1, durationMs: 100 },
				],
			},
		],
	};
}
describe("measured profile selection", () => {
	it("prioritizes complete task success, then includes failed trials in cost per pass", () => {
		const input = calibration();
		const result = selectExecutionProfile(input);
		expect(result.profile.id).toBe("correct");
		expect(result.scores.find(score => score.id === "cheap")?.costPerPassUsd).toBe(0.02);
		input.candidates[1]!.trials[1]!.status = "fail";
		expect(selectExecutionProfile(input).profile.id).toBe("cheap");
	});
	it("imports observed Harbor failures with their cost and refuses partial reward as task success", () => {
		const snapshot: BenchmarkSnapshot = {
			traces: [
				{
					name: "a__1",
					task: "a",
					status: "pass",
					reward: 1,
					costUsd: 1,
					durationMs: 100,
					detail: "",
					tracePath: null,
				},
				{
					name: "b__1",
					task: "b",
					status: "fail",
					reward: 0,
					costUsd: 2,
					durationMs: 100,
					detail: "",
					tracePath: null,
				},
			],
			total: 2,
			done: 2,
			pass: 1,
			fail: 1,
			error: 0,
			running: 0,
			costUsd: 3,
			tokIn: 0,
			tokOut: 0,
			tokCache: 0,
			score: 0.5,
			metrics: {},
		};
		const input = calibration();
		input.candidates = [candidateFromHarbor("actual", input.candidates[0]!.settings, snapshot)];
		expect(selectExecutionProfile(input).profile.measurement.costPerPassUsd).toBe(3);
		snapshot.traces[0]!.reward = 0.5;
		expect(() => candidateFromHarbor("partial", input.candidates[0]!.settings, snapshot)).toThrow("binary full-task");
	});

	it("refuses unpaired samples, infrastructure failures and overlap with the formal task set", () => {
		const input = calibration();
		input.candidates[0]!.trials.pop();
		expect(() => selectExecutionProfile(input)).toThrow("Incomplete");
		const infra = calibration();
		infra.candidates[0]!.trials[0]!.status = "infra";
		expect(() => selectExecutionProfile(infra)).toThrow("infrastructure");
		const overlap = calibration();
		overlap.evaluationTaskIds.push("a");
		expect(() => selectExecutionProfile(overlap)).toThrow("disjoint");
	});
});
