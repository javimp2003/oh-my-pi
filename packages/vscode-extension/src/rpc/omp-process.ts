/**
 * One `omp --mode rpc-ui` child process: JSONL framing over stdio, protocol
 * v2 negotiation (`rpc_chunk` reassembly), request/response correlation by
 * id, and dispatch of every other frame to listeners.
 *
 * Wire contract: docs/rpc.md and `modes/rpc/wire/rpc-wire.generated.ts`.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import type {
	ExtensionUiRequest,
	ExtensionUiResponse,
	RpcNotification,
	RpcResponse,
	RpcWireCommands,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/rpc-wire.generated";

export type OmpCommandName = keyof RpcWireCommands;
export type OmpResult<K extends OmpCommandName> = RpcWireCommands[K]["result"];
/** A command's params (omitted for parameterless commands), then an optional timeout override. */
type RequestArgs<K extends OmpCommandName> = RpcWireCommands[K]["params"] extends undefined
	? [params?: undefined, timeoutMs?: number]
	: [params: RpcWireCommands[K]["params"], timeoutMs?: number];

/** How to launch omp: the program plus arguments placed before the RPC flags. */
export interface OmpCommand {
	executable: string;
	args: readonly string[];
	env: Readonly<Record<string, string>>;
	cwd: string;
}

/** Thrown for a command omp answered with `success: false`. */
export class OmpCommandError extends Error {
	constructor(
		readonly command: string,
		message: string,
		readonly code?: string,
	) {
		super(message);
		this.name = "OmpCommandError";
	}
}

interface PendingRequest {
	resolve(data: unknown): void;
	reject(error: Error): void;
	timer: NodeJS.Timeout | undefined;
}

interface ChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

/**
 * Commands answered only when long work finishes (a whole OAuth flow, a shell
 * command, a compaction, the OS microphone permission prompt).
 */
const UNBOUNDED_COMMANDS: Record<string, true> = {
	login: true,
	bash: true,
	compact: true,
	handoff: true,
	get_available_models: true,
	set_model: true,
	dictation_start: true,
};
const DEFAULT_TIMEOUT_MS = 30_000;
/** Matches the server's advertised `maxReassembledFrameBytes`. */
const MAX_REASSEMBLED_BYTES = 64 * 1024 * 1024;

export interface OmpProcessEvents {
	/** Any non-response frame: session events, prompt results, notifications. */
	frame: [frame: RpcNotification];
	/** An extension UI dialog or presentation update the host must answer or show. */
	uiRequest: [request: ExtensionUiRequest];
	/** Raw stderr text (diagnostics). */
	stderr: [text: string];
	/** The process exited; `reason` is a user-facing explanation. */
	exit: [reason: string];
}

export class OmpProcess extends EventEmitter<OmpProcessEvents> {
	#child: ChildProcess | undefined;
	#nextId = 1;
	readonly #pending = new Map<string, PendingRequest>();
	#buffer = "";
	#chunks: { id: string; count: number; byteLength: number; parts: Buffer[]; size: number } | undefined;
	#stderrTail = "";
	#exited = false;
	readonly #ready = Promise.withResolvers<void>();

	constructor(readonly command: OmpCommand) {
		super();
		// The ready promise may be rejected before anyone awaits it.
		this.#ready.promise.catch(() => {});
	}

	/** Spawn omp and resolve once it is ready for commands (protocol v2 negotiated when offered). */
	async start(extraArgs: readonly string[]): Promise<void> {
		const { executable, args, env, cwd } = this.command;
		const child = spawn(executable, [...args, "--mode", "rpc-ui", ...extraArgs], {
			cwd,
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		this.#child = child;
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (data: string) => this.#onStdout(data));
		child.stderr?.setEncoding("utf8");
		child.stderr?.on("data", (data: string) => {
			this.#stderrTail = (this.#stderrTail + data).slice(-4000);
			this.emit("stderr", data);
		});
		child.on("error", error => {
			const code = (error as NodeJS.ErrnoException).code;
			this.#finish(
				code === "ENOENT"
					? `Could not find "${executable}". Install the MarIA Code engine (omp) or set "ompCustom.executable" to its path.`
					: `Could not start "${executable}": ${error.message}`,
			);
		});
		child.on("exit", (code, signal) => {
			const tail = this.#stderrTail.trim().split("\n").slice(-6).join("\n");
			const how = signal ? `was killed (${signal})` : `exited with code ${code}`;
			this.#finish(tail ? `MarIA Code ${how}:\n${tail}` : `MarIA Code ${how}.`);
		});
		await this.#ready.promise;
	}

	get running(): boolean {
		return this.#child !== undefined && !this.#exited;
	}

	/** Send a command and resolve with its `data`; rejects with {@link OmpCommandError} on failure. */
	request<K extends OmpCommandName>(type: K, ...[params, timeoutMs]: RequestArgs<K>): Promise<OmpResult<K>> {
		if (!this.running) return Promise.reject(new Error("MarIA Code is not running"));
		const id = `vsc_${this.#nextId++}`;
		const limit = timeoutMs ?? (UNBOUNDED_COMMANDS[type] ? undefined : DEFAULT_TIMEOUT_MS);
		const { promise, resolve, reject } = Promise.withResolvers<OmpResult<K>>();
		const timer =
			limit === undefined
				? undefined
				: setTimeout(() => {
						this.#pending.delete(id);
						reject(new Error(`MarIA Code did not answer "${type}" within ${limit / 1000}s`));
					}, limit);
		this.#pending.set(id, { resolve: data => resolve(data as OmpResult<K>), reject, timer });
		this.#write({ ...params, id, type });
		return promise;
	}

	/** Answer an extension UI request. */
	respond(response: ExtensionUiResponse): void {
		if (this.running) this.#write(response);
	}

	/** Close stdin (omp drains and exits) and kill it if it lingers. */
	async stop(): Promise<void> {
		const child = this.#child;
		if (!child || this.#exited) return;
		const exited = Promise.withResolvers<void>();
		child.once("exit", () => exited.resolve());
		child.stdin?.end();
		const timer = setTimeout(() => child.kill(), 3000);
		await exited.promise;
		clearTimeout(timer);
	}

	#write(frame: object): void {
		this.#child?.stdin?.write(`${JSON.stringify(frame)}\n`);
	}

	#onStdout(data: string): void {
		this.#buffer += data;
		let newline = this.#buffer.indexOf("\n");
		while (newline >= 0) {
			const line = this.#buffer.slice(0, newline).trim();
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line) this.#onLine(line);
			newline = this.#buffer.indexOf("\n");
		}
	}

	#onLine(line: string): void {
		let frame: { type?: unknown };
		try {
			frame = JSON.parse(line);
		} catch {
			// Not a protocol frame (stray output); surface it as a diagnostic.
			this.emit("stderr", `${line}\n`);
			return;
		}
		if (frame.type === "rpc_chunk") {
			const whole = this.#onChunk(frame as ChunkFrame);
			if (whole) this.#dispatch(whole);
			return;
		}
		this.#dispatch(frame);
	}

	#onChunk(chunk: ChunkFrame): { type?: unknown } | undefined {
		if (chunk.index === 0) {
			if (chunk.byteLength > MAX_REASSEMBLED_BYTES) throw new Error("MarIA Code frame exceeds the reassembly limit");
			this.#chunks = { id: chunk.chunkId, count: chunk.count, byteLength: chunk.byteLength, parts: [], size: 0 };
		}
		const pending = this.#chunks;
		if (!pending || pending.id !== chunk.chunkId || chunk.index !== pending.parts.length) {
			this.#chunks = undefined;
			this.emit("stderr", `dropped an interrupted rpc_chunk sequence (${chunk.chunkId})\n`);
			return undefined;
		}
		const part = Buffer.from(chunk.data, "base64");
		pending.parts.push(part);
		pending.size += part.byteLength;
		if (pending.parts.length < pending.count) return undefined;
		this.#chunks = undefined;
		const bytes = Buffer.concat(pending.parts);
		if (bytes.byteLength !== pending.byteLength) {
			this.emit("stderr", `rpc_chunk length mismatch (${chunk.chunkId})\n`);
			return undefined;
		}
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	}

	#dispatch(frame: { type?: unknown }): void {
		switch (frame.type) {
			case "ready":
				void this.#negotiate(frame as { supportedProtocolVersions?: number[] });
				return;
			case "response":
				this.#onResponse(frame as RpcResponse);
				return;
			case "extension_ui_request":
				this.emit("uiRequest", frame as ExtensionUiRequest);
				return;
			default:
				this.emit("frame", frame as RpcNotification);
		}
	}

	async #negotiate(ready: { supportedProtocolVersions?: number[] }): Promise<void> {
		if (ready.supportedProtocolVersions?.includes(2)) {
			try {
				await this.request("negotiate_protocol", { protocolVersion: 2 });
			} catch (error) {
				// v1 still works; only oversized frames degrade.
				this.emit("stderr", `protocol v2 negotiation failed: ${String(error)}\n`);
			}
		}
		this.#ready.resolve();
	}

	#onResponse(response: RpcResponse): void {
		const pending = response.id === undefined ? undefined : this.#pending.get(response.id);
		if (!pending) {
			if (!response.success) this.emit("stderr", `MarIA Code ${response.command} failed: ${response.error}\n`);
			return;
		}
		this.#pending.delete(response.id!);
		clearTimeout(pending.timer);
		if (response.success) pending.resolve(response.data);
		else pending.reject(new OmpCommandError(response.command, response.error ?? "failed", response.code));
	}

	#finish(reason: string): void {
		if (this.#exited) return;
		this.#exited = true;
		const error = new Error(reason);
		this.#ready.reject(error);
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
		this.emit("exit", reason);
	}
}
