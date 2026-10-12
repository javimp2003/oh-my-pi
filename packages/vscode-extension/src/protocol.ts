/**
 * Messages between the extension host and its webviews (`postMessage`).
 *
 * The chat webview renders omp's RPC wire types directly: the host forwards
 * every live session event untouched (`event`) and supplies snapshots the
 * webview cannot derive from events alone (transcript history after a session
 * switch, state, models). Commands flow back as `ChatRequest`s; the host owns
 * the omp process, VS Code dialogs, and the session store.
 *
 * Shared by `src/` (host, Node) and `webview/` (browser); type-only imports.
 */
import type {
	AgentMessage,
	AvailableSlashCommand,
	RpcAgentEvent,
	SessionState,
	SessionStats,
	ThinkingLevel,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/rpc-wire.generated";

export type {
	AgentMessage,
	AssistantMessage,
	AvailableSlashCommand,
	BashExecutionMessage,
	CustomMessage,
	ImageContent,
	RpcAgentEvent,
	SessionState,
	SessionStats,
	TextContent,
	ThinkingContent,
	ThinkingLevel,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/rpc-wire.generated";

/** A model the user can pick (trimmed from omp's catalog entry). */
export interface ModelChoice {
	provider: string;
	id: string;
	name: string;
	reasoning: boolean;
	contextWindow: number | null;
}

/** Lifecycle of the omp process behind a chat view. */
export type AgentStatus =
	| { phase: "starting" }
	| { phase: "ready" }
	/** The process exited or could not start; `message` explains why (missing binary, crash). */
	| { phase: "stopped"; message: string };

/** Host → chat webview. */
export type ChatUpdate =
	| { type: "status"; status: AgentStatus }
	/**
	 * Replace the whole transcript (startup, session switch, new session).
	 * Messages are in chronological order; tool results follow their assistant
	 * message and pair with its tool calls by `toolCallId`.
	 */
	| { type: "history"; messages: AgentMessage[] }
	/**
	 * One live session event exactly as omp emitted it (`message_start`,
	 * `message_update`, `message_end`, `tool_execution_*`, `agent_start`,
	 * `agent_end`, `queue_update`, `auto_compaction_*`, `auto_retry_*`,
	 * `notice`, ...). `message_*` frames carry `messageId`, stable from start to end.
	 */
	| { type: "event"; event: RpcAgentEvent & { messageId?: string } }
	/** Session snapshot; re-sent after every turn, model change, or session switch. */
	| { type: "state"; state: SessionState; stats?: SessionStats; title?: string }
	| { type: "models"; models: ModelChoice[] }
	| { type: "thinkingLevels"; levels: ThinkingLevel[] }
	/** Slash commands for composer completion. */
	| { type: "commands"; commands: AvailableSlashCommand[] }
	/** Text printed by a local slash command (no agent turn). */
	| { type: "commandOutput"; text: string }
	/** Transient banner (errors, info) shown above the composer. */
	| { type: "notice"; level: "info" | "warning" | "error"; message: string }
	/** Insert text at the composer cursor (Add Selection / Add File) and focus it. */
	| { type: "insertText"; text: string }
	| { type: "focusInput" };

/** Chat webview → host. */
export type ChatRequest =
	/** Webview loaded; the host replies with status, history, state, models, commands. */
	| { type: "ready" }
	/** Send a prompt. While the agent is busy the host queues it (`ompCustom.sendWhileBusy`). */
	| { type: "prompt"; text: string }
	| { type: "abort" }
	| { type: "newSession" }
	/** Open the session picker (QuickPick on the host). */
	| { type: "showSessions" }
	| { type: "setModel"; provider: string; modelId: string }
	| { type: "setThinkingLevel"; level: ThinkingLevel }
	| { type: "openSettings" }
	| { type: "login" }
	| { type: "compact" }
	| { type: "restart" }
	/** Open a file the transcript mentions; relative paths resolve against the workspace. */
	| { type: "openFile"; path: string; line?: number }
	| { type: "openExternal"; url: string }
	/** Remove a queued (not yet delivered) message. */
	| { type: "removeQueued"; message: string; queue: "steering" | "followUp" };

/** One setting row in the settings panel (from `omp config list --json`). */
export interface SettingEntry {
	key: string;
	type: "boolean" | "string" | "number" | "enum" | "array" | "record";
	/** Effective value; absent for unset settings and for redacted credentials. */
	value?: unknown;
	redacted?: boolean;
	default?: unknown;
	description: string;
	values?: string[];
	ui?: {
		tab: string;
		group?: string;
		label: string;
		warning?: string;
		options?: { value: string; label: string; description?: string }[];
	};
}

/** Host → settings webview. */
export type SettingsUpdate =
	| { type: "settings"; entries: SettingEntry[]; configPath: string }
	/** Result of a `set`/`reset`: the new effective value, or the error omp reported. */
	| { type: "saved"; key: string; value?: unknown; error?: string }
	| { type: "error"; message: string };

/** Settings webview → host. */
export type SettingsRequest =
	| { type: "ready" }
	| { type: "refresh" }
	/** `value` is passed verbatim to `omp config set <key> <value>` (arrays/records as JSON). */
	| { type: "set"; key: string; value: string }
	| { type: "reset"; key: string }
	| { type: "openConfigFile" };
