import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as transcription from "@oh-my-pi/pi-ai/transcription";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcDictationBridge } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-dictation";
import type { RpcDictationStateFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import * as downloader from "@oh-my-pi/pi-coding-agent/stt/downloader";
import { STTController } from "@oh-my-pi/pi-coding-agent/stt/stt-controller";

const ZERO_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

type OnAudio = (error: Error | null, samples: Float32Array) => void;

function harness(options: { available: Model[]; settings?: Record<string, unknown> }) {
	const settings = Settings.isolated({ "stt.submitTrigger": "never", ...options.settings });
	const registry = {
		getError: () => undefined,
		getAvailable: () => options.available,
		getAll: () => options.available,
		resolver: vi.fn(() => vi.fn().mockResolvedValue("gsk-test")),
	};
	const session = { settings, modelRegistry: registry, sessionId: "session-1" } as unknown as AgentSession;
	const frames: RpcDictationStateFrame[] = [];
	const mic: { onAudio?: OnAudio; stops: number } = { stops: 0 };
	const bridge = new RpcDictationBridge(
		session,
		frame => frames.push(frame),
		() =>
			new STTController(
				onAudio => {
					mic.onAudio = onAudio;
					return { stop: () => mic.stops++ };
				},
				{ settings, registry, getSessionId: () => "session-1" },
			),
	);
	return { bridge, frames, mic, settings };
}

const groqTurbo = () => getBundledModel("groq", "whisper-large-v3-turbo");

describe("RpcDictationBridge", () => {
	let bridges: RpcDictationBridge[] = [];
	const track = <T extends { bridge: RpcDictationBridge }>(h: T): T => {
		bridges.push(h.bridge);
		return h;
	};

	beforeEach(() => {
		bridges = [];
	});

	afterEach(() => {
		for (const bridge of bridges) bridge.cancel();
		vi.restoreAllMocks();
	});

	it("records with Groq's Whisper when a Groq key is available and returns the transcript", async () => {
		const { bridge, frames, mic } = track(harness({ available: [groqTurbo()] }));
		const transcribe = vi
			.spyOn(transcription, "transcribeAudio")
			.mockResolvedValue({ text: " Revisa el fichero de configuración. ", usage: ZERO_USAGE });

		expect(await bridge.start({ language: "es" })).toEqual({ model: "groq/whisper-large-v3-turbo" });
		mic.onAudio?.(null, new Float32Array(1600).fill(0.25));
		expect(await bridge.stop()).toEqual({ text: "Revisa el fichero de configuración.", submit: false });

		expect(mic.stops).toBe(1);
		const [model, request] = transcribe.mock.calls[0]!;
		expect(model.baseUrl).toBe("https://api.groq.com/openai/v1");
		expect(request).toMatchObject({ language: "es", mimeType: "audio/wav" });
		const states = frames.map(frame => frame.state).filter((state, index, all) => state !== all[index - 1]);
		expect(states).toEqual(["recording", "transcribing", "idle"]);
		expect(frames.at(-1)).toEqual({
			type: "dictation_state",
			state: "idle",
			text: "Revisa el fichero de configuración.",
		});
		expect(bridge.active).toBe(false);
	});

	it("lets the model detect the language when the host passes an empty language", async () => {
		const { bridge, mic } = track(harness({ available: [groqTurbo()], settings: { "stt.language": "en" } }));
		const transcribe = vi
			.spyOn(transcription, "transcribeAudio")
			.mockResolvedValue({ text: "hola", usage: ZERO_USAGE });

		await bridge.start({ language: "" });
		mic.onAudio?.(null, new Float32Array(160));
		await bridge.stop();
		expect(transcribe.mock.calls[0]![1].language).toBeUndefined();

		// Without an override the configured `stt.language` applies again.
		await bridge.start();
		mic.onAudio?.(null, new Float32Array(160));
		await bridge.stop();
		expect(transcribe.mock.calls[1]![1].language).toBe("en");
	});

	it("reports a spoken submit trigger and strips the trigger word", async () => {
		const { bridge, mic } = track(
			harness({ available: [groqTurbo()], settings: { "stt.submitTrigger": "say-submit" } }),
		);
		vi.spyOn(transcription, "transcribeAudio").mockResolvedValue({
			text: "run the tests submit.",
			usage: ZERO_USAGE,
		});

		await bridge.start();
		mic.onAudio?.(null, new Float32Array(160));
		expect(await bridge.stop()).toEqual({ text: "run the tests", submit: true });
	});

	it("fails the stop with the transcription error and returns to idle", async () => {
		const { bridge, frames, mic } = track(harness({ available: [groqTurbo()] }));
		vi.spyOn(transcription, "transcribeAudio").mockRejectedValue(
			new Error("groq/whisper-large-v3-turbo transcription API error (401): Invalid API Key"),
		);

		await bridge.start();
		mic.onAudio?.(null, new Float32Array(160));
		await expect(bridge.stop()).rejects.toThrow(/401/);
		expect(frames.at(-1)?.state).toBe("idle");
		expect(bridge.active).toBe(false);
	});

	it("ends the capture with an error frame when the microphone fails mid-recording", async () => {
		const { bridge, frames, mic } = track(harness({ available: [groqTurbo()] }));

		await bridge.start();
		mic.onAudio?.(new Error("Microphone disconnected"), new Float32Array(0));

		expect(frames.at(-1)).toEqual({ type: "dictation_state", state: "idle", error: "Microphone disconnected" });
		await expect(bridge.stop()).rejects.toMatchObject({ code: "not_dictating" });
	});

	it("refuses a second start while recording and a stop when idle", async () => {
		const { bridge } = track(harness({ available: [groqTurbo()] }));

		await expect(bridge.stop()).rejects.toMatchObject({ code: "not_dictating" });
		await bridge.start();
		await expect(bridge.start()).rejects.toMatchObject({ code: "dictation_busy" });
	});

	it("drops a cancelled capture without transcribing it", async () => {
		const { bridge, frames, mic } = track(harness({ available: [groqTurbo()] }));
		const transcribe = vi.spyOn(transcription, "transcribeAudio");

		await bridge.start();
		mic.onAudio?.(null, new Float32Array(160));
		bridge.cancel();

		expect(mic.stops).toBe(1);
		expect(transcribe).not.toHaveBeenCalled();
		expect(frames.at(-1)).toEqual({ type: "dictation_state", state: "idle" });
		expect(bridge.active).toBe(false);
	});

	it("never falls back to a local speech model", async () => {
		const local = getBundledModel("local", "parakeet-tdt-0.6b-v3");
		const { bridge, mic } = track(harness({ available: [local] }));
		const cached = vi.spyOn(downloader, "isSttModelCached");

		await expect(bridge.start()).rejects.toMatchObject({ code: "no_dictation_model" });
		expect(mic.onAudio).toBeUndefined();
		expect(cached).not.toHaveBeenCalled();
		expect(bridge.active).toBe(false);
	});

	it("uses the cloud model even when the dictation role names a local one first", async () => {
		const local = getBundledModel("local", "parakeet-tdt-0.6b-v3");
		const { bridge, mic } = track(
			harness({
				available: [local, groqTurbo()],
				settings: { modelRoles: { dictation: "local/parakeet-tdt-0.6b-v3" } },
			}),
		);
		const transcribe = vi
			.spyOn(transcription, "transcribeAudio")
			.mockResolvedValue({ text: "hola", usage: ZERO_USAGE });

		expect(await bridge.start()).toEqual({ model: "groq/whisper-large-v3-turbo" });
		mic.onAudio?.(null, new Float32Array(160));
		expect(await bridge.stop()).toEqual({ text: "hola", submit: false });
		expect(transcribe.mock.calls[0]![0].provider).toBe("groq");
	});
});
