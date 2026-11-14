#!/usr/bin/env bun
/** Select a frozen runtime profile from complete, paired development results. */
import * as path from "node:path";
import { stableStringifyJson } from "@oh-my-pi/pi-utils";
import { normalizeEditMode } from "@oh-my-pi/pi-coding-agent/edit/modes";
import { readBenchmarkSnapshot } from "../src/benchmarks";
import { parseArgs, resolveResumeConfig } from "../src/runner";
import { candidateFromHarbor, selectExecutionProfile, type ProfileCalibration } from "../src/execution-profiles";
const [input, output, mode] = Bun.argv.slice(2);
if (!input || !output)
	throw new Error("Usage: bun scripts/select-execution-profile.ts calibration.json selected-profile.json [--runs]");
const calibration: ProfileCalibration = await Bun.file(input).json();
if (mode === "--runs") {
	const spec: ProfileCalibration & { runs: string[] } = await Bun.file(input).json();
	if (!Array.isArray(spec.runs) || !spec.runs.length) throw new Error("--runs needs Harbor job directories");
	let baseline: string | undefined;
	calibration.candidates = spec.runs.map(job => {
		const dir = path.resolve(path.dirname(path.resolve(input)), job);
		const config = resolveResumeConfig(parseArgs(["--resume", dir]));
		const edit = normalizeEditMode(config.env.PI_EDIT_VARIANT);
		const docs = config.settings["tools.xdevDocs"];
		if (!edit || (docs !== "inline" && docs !== "builtins" && docs !== "catalog"))
			throw new Error("Pin PI_EDIT_VARIANT and tools.xdevDocs in every calibration run");
		if (
			config.agent !== "omp" ||
			config.models.length !== 1 ||
			config.models[0] !== `${spec.target.provider}/${spec.target.model}`
		)
			throw new Error("Calibration run must use the selected omp model and a single model configuration");
		const { PI_EDIT_VARIANT: _editor, ...environment } = config.env;
		const { "edit.mode": _mode, "tools.xdevDocs": _docs, ...otherSettings } = config.settings;
		const fixed = stableStringifyJson({
			dataset: config.dataset,
			models: config.models,
			agent: config.agent,
			thinking: config.thinking,
			tools: config.tools,
			agentArgs: config.agentArgs,
			environment,
			settings: otherSettings,
			timeoutMultiplier: config.timeoutMultiplier,
			attempts: config.attempts,
		});
		if (baseline !== undefined && baseline !== fixed)
			throw new Error(
				"Calibration arms differ beyond the selected editor/docs settings; keep the experiment paired",
			);
		baseline = fixed;
		return candidateFromHarbor(
			path.basename(dir),
			{ "edit.mode": edit, "tools.xdevDocs": docs },
			readBenchmarkSnapshot("harbor", dir),
		);
	});
} else if (mode !== undefined) throw new Error("Unknown profile selection mode");
const { profile, scores } = selectExecutionProfile(calibration);
await Bun.write(output, `${JSON.stringify(profile, null, 2)}\n`);
console.log(JSON.stringify({ selected: profile.id, scores }, null, 2));
