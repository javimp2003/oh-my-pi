import type { BenchmarkSnapshot } from "./benchmarks";
import {
	parseExecutionProfile,
	type ExecutionProfile,
} from "@oh-my-pi/pi-coding-agent/session/execution-profile-schema";

export interface ProfileTrial {
	task: string;
	status: "pass" | "fail" | "timeout" | "infra";
	costUsd: number;
	durationMs: number;
}
export interface ProfileCandidate {
	id: string;
	settings: ExecutionProfile["settings"];
	trials: ProfileTrial[];
}
export interface ProfileCalibration {
	split: "development";
	target: ExecutionProfile["target"];
	taskIds: string[];
	evaluationTaskIds: string[];
	candidates: ProfileCandidate[];
}
export interface ProfileScore {
	id: string;
	passed: number;
	total: number;
	totalCostUsd: number;
	costPerPassUsd: number | null;
	meanDurationMs: number;
}

/** Paired, complete development tasks only. Full-task correctness wins before cost/pass and latency. */
export function selectExecutionProfile(input: ProfileCalibration): {
	profile: ExecutionProfile;
	scores: ProfileScore[];
} {
	if (
		input.split !== "development" ||
		!input.taskIds.length ||
		new Set(input.taskIds).size !== input.taskIds.length ||
		!input.candidates.length ||
		input.taskIds.some(id => input.evaluationTaskIds.includes(id))
	)
		throw new Error("Use disjoint development tasks, never formal evaluation tasks, for calibration");
	const ids = new Set<string>();
	const scores = input.candidates
		.map(candidate => {
			if (!candidate.id || ids.has(candidate.id)) throw new Error("Profile candidate ids must be unique");
			ids.add(candidate.id);
			const tasks = new Map<string, ProfileTrial>();
			for (const trial of candidate.trials) {
				if (
					!input.taskIds.includes(trial.task) ||
					tasks.has(trial.task) ||
					!["pass", "fail", "timeout", "infra"].includes(trial.status) ||
					!Number.isFinite(trial.costUsd) ||
					trial.costUsd < 0 ||
					!Number.isFinite(trial.durationMs) ||
					trial.durationMs < 0
				)
					throw new Error("Each candidate needs one valid full-task result per development task");
				tasks.set(trial.task, trial);
			}
			if (tasks.size !== input.taskIds.length || candidate.trials.some(trial => trial.status === "infra"))
				throw new Error("Incomplete or infrastructure-failed calibration; repair and rerun the paired sample");
			const passed = candidate.trials.filter(trial => trial.status === "pass").length;
			const totalCostUsd = candidate.trials.reduce((sum, trial) => sum + trial.costUsd, 0);
			return {
				id: candidate.id,
				passed,
				total: tasks.size,
				totalCostUsd,
				costPerPassUsd: passed ? totalCostUsd / passed : null,
				meanDurationMs: candidate.trials.reduce((sum, trial) => sum + trial.durationMs, 0) / tasks.size,
			};
		})
		.sort(
			(a, b) =>
				b.passed - a.passed ||
				(a.costPerPassUsd ?? Infinity) - (b.costPerPassUsd ?? Infinity) ||
				a.meanDurationMs - b.meanDurationMs ||
				a.id.localeCompare(b.id),
		);
	const best = scores[0]!;
	if (!best.passed) throw new Error("No candidate passed any full task; no profile can be promoted");
	const candidate = input.candidates.find(candidate => candidate.id === best.id)!;
	const profile = parseExecutionProfile({
		version: 1,
		id: candidate.id,
		target: input.target,
		settings: candidate.settings,
		measurement: {
			split: "development",
			taskIds: input.taskIds,
			passed: best.passed,
			total: best.total,
			totalCostUsd: best.totalCostUsd,
			costPerPassUsd: best.costPerPassUsd,
			meanDurationMs: best.meanDurationMs,
		},
	});
	return { profile, scores };
}

/** Normalize observed Harbor trials; edit-operation and partial-reward scores cannot promote a profile. */
export function candidateFromHarbor(
	id: string,
	settings: ExecutionProfile["settings"],
	snapshot: BenchmarkSnapshot,
): ProfileCandidate {
	if (snapshot.running > 0 || snapshot.done !== snapshot.total || snapshot.traces.length !== snapshot.total)
		throw new Error("Calibration run has not completed every trial");
	return {
		id,
		settings,
		trials: snapshot.traces.map(trace => {
			if ((trace.status === "pass" && trace.reward !== 1) || (trace.status === "fail" && trace.reward !== 0))
				throw new Error("Calibration requires binary full-task rewards");
			return {
				task: trace.task,
				status: trace.status === "pass" ? "pass" : trace.status === "fail" ? "fail" : "infra",
				costUsd: trace.costUsd,
				durationMs: trace.durationMs,
			};
		}),
	};
}
