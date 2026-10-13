/**
 * Dictation for RPC mode: records the default microphone through the same
 * {@link STTController} as the TUI's speech-to-text (native capture) and
 * transcribes it through a cloud transcription API (the first
 * `openai-transcriptions` model of the `dictation` role chain, e.g. Groq's
 * Whisper), then hands the text to the host instead of an editor. Local
 * speech models are never used here: hosts get no model download. State
 * changes and the transcript go out as unsolicited `dictation_state` frames.
 */
import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import { resolveRoleChain } from "../../config/model-resolver";
import { roleCandidatePool } from "../../config/model-roles";
import type { AgentSession } from "../../session/agent-session";
import { type SttCallbacks, STTController, type SttState, type SttTarget } from "../../stt/stt-controller";
import type { RpcDictationStateFrame } from "./rpc-types";

/** The controller surface the bridge drives. */
export type RpcDictationController = Pick<STTController, "state" | "start" | "stop" | "dispose">;

/** Builds the controller for a capture; tests substitute a fake. */
export type RpcDictationControllerFactory = (session: AgentSession) => RpcDictationController;

/** `dictation_start` parameters. */
export interface RpcDictationStartOptions {
	/** Source language for this capture (`""` lets the model detect it); `stt.language` when omitted. */
	language?: string;
}

/** A failed dictation command, with an optional machine-readable `code` for the response. */
export class RpcDictationError extends Error {
	constructor(
		message: string,
		readonly code?: "no_dictation_model" | "dictation_busy" | "not_dictating",
	) {
		super(message);
		this.name = "RpcDictationError";
	}
}

function defaultController(session: AgentSession): RpcDictationController {
	return new STTController({
		settings: session.settings,
		registry: session.modelRegistry,
		getSessionId: () => session.sessionId,
	});
}

/** Owns at most one dictation capture for an RPC server. */
export class RpcDictationBridge {
	readonly #session: AgentSession;
	readonly #output: (frame: RpcDictationStateFrame) => void;
	readonly #createController: RpcDictationControllerFactory;
	#controller: RpcDictationController | undefined;
	/** Text the capture committed, and the in-progress segment of a streaming model. */
	#committed = "";
	#volatile = "";
	#submit = false;
	/** The last warning the controller reported during the current step. */
	#warning: string | undefined;
	#state: SttState = "idle";
	/** A start or stop is in flight: its warnings go to the command's response, not a frame. */
	#stepping = false;

	constructor(
		session: AgentSession,
		output: (frame: RpcDictationStateFrame) => void,
		createController: RpcDictationControllerFactory = defaultController,
	) {
		this.#session = session;
		this.#output = output;
		this.#createController = createController;
	}

	/** Whether a capture is recording or transcribing. */
	get active(): boolean {
		return this.#state !== "idle";
	}

	/** Start recording; resolves with the speech model in use once the microphone is open. */
	async start(options: RpcDictationStartOptions = {}): Promise<{ model: string }> {
		if (this.active) throw new RpcDictationError("Dictation is already running", "dictation_busy");
		const model = this.#resolveModel();
		if (!model) {
			throw new RpcDictationError(
				"No cloud speech-to-text model is available: log in to Groq (or another transcription provider)",
				"no_dictation_model",
			);
		}
		this.#committed = "";
		this.#volatile = "";
		this.#submit = false;
		this.#warning = undefined;
		this.#controller ??= this.#createController(this.#session);
		this.#stepping = true;
		try {
			await this.#controller.start(this.#target(), this.#callbacks(), { language: options.language, model });
		} finally {
			this.#stepping = false;
		}
		if (this.#controller.state !== "recording") {
			throw new RpcDictationError(this.#warning ?? "Could not start dictation");
		}
		return { model: `${model.provider}/${model.id}` };
	}

	/**
	 * Stop recording and transcribe. `submit` is true when `stt.submitTrigger`
	 * asks for the text to be sent (a spoken "submit" is already removed).
	 */
	async stop(): Promise<{ text: string; submit: boolean }> {
		const controller = this.#controller;
		if (!controller || this.#state !== "recording") {
			throw new RpcDictationError("Dictation is not running", "not_dictating");
		}
		this.#warning = undefined;
		this.#stepping = true;
		try {
			await controller.stop();
		} finally {
			this.#stepping = false;
		}
		if (this.#warning) throw new RpcDictationError(this.#warning);
		return { text: this.#committed.trim(), submit: this.#submit };
	}

	/** Drop the capture without transcribing it, releasing the microphone. No-op when idle. */
	cancel(): void {
		const controller = this.#controller;
		this.#controller = undefined;
		if (!controller) return;
		controller.dispose();
		if (this.#state !== "idle") {
			this.#state = "idle";
			this.#committed = "";
			this.#volatile = "";
			this.#output({ type: "dictation_state", state: "idle" });
		}
	}

	/** The first cloud transcription model of the `dictation` role chain; local models are skipped. */
	#resolveModel(): Model<Api> | undefined {
		const settings = this.#session.settings;
		const pool = roleCandidatePool("dictation", settings, this.#session.modelRegistry);
		return resolveRoleChain("dictation", settings, pool).find(
			candidate => candidate.model.api === "openai-transcriptions",
		)?.model;
	}

	#text(): string {
		return `${this.#committed}${this.#volatile}`;
	}

	#emit(error?: string): void {
		const text = this.#text().trim();
		this.#output({
			type: "dictation_state",
			state: this.#state,
			...(text && { text }),
			...(error && { error }),
		});
	}

	#target(): SttTarget {
		return {
			setVolatileText: text => {
				this.#volatile = text;
				this.#emit();
			},
			clearVolatileText: () => {
				this.#volatile = "";
				this.#emit();
			},
			commitVolatileText: text => {
				this.#committed += text;
				this.#volatile = "";
				this.#emit();
			},
			deleteBeforeCursor: count => {
				this.#committed = this.#committed.slice(0, Math.max(0, this.#committed.length - count));
			},
			submit: () => {
				this.#submit = true;
			},
		};
	}

	#callbacks(): SttCallbacks {
		return {
			showWarning: message => {
				this.#warning = message;
				// A capture that ended on its own (the microphone failed) reports why.
				if (!this.#stepping && this.#state === "idle") this.#emit(message);
			},
			showStatus: () => {},
			onStateChange: state => {
				this.#state = state;
				this.#emit();
			},
		};
	}
}
