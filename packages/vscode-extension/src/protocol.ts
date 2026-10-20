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
 * It also holds the few pure helpers both sides must agree on (which messages
 * are editable prompts and their draft text).
 */
import type {
	AgentMessage,
	AvailableSlashCommand,
	ImageContent,
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

/** `details` of omp's `skill-prompt` custom message (packages/tui/src/chat/messages.ts `SkillPromptDetails`). */
export interface SkillPromptDetails {
	name: string;
	args?: string;
	/** The draft as submitted, `/skill:<name>` token in place; absent on older sessions. */
	prompt?: string;
	lineCount?: number;
}

export function isSkillPromptDetails(details: unknown): details is SkillPromptDetails {
	return typeof details === "object" && details !== null && "name" in details && typeof details.name === "string";
}

/** The draft of a skill invocation as submitted, `/skill:<name>` token in place. */
export function skillPromptDraft(details: SkillPromptDetails): string {
	const token = `/skill:${details.name}`;
	return details.prompt ?? (details.args ? `${token} ${details.args}` : token);
}

/**
 * A prompt the user wrote, and so can edit: a non-synthetic user message, or a
 * `/skill:` prompt the user invoked (attribution `user`). Agent/autoload skill
 * injections are not: omp's `navigate_tree` does not rewind to them.
 * Host (`#findPrompt`, via prompt-entries.ts) and webview count prompts with this.
 */
export function isUserPrompt(message: AgentMessage): boolean {
	if (message.role === "user") return !message.synthetic;
	return message.role === "custom" && message.customType === "skill-prompt" && message.attribution === "user";
}

/** What a session is doing in this window: working, or finished while no chat showed it. */
export type SessionActivity = "running" | "done";

/** One row of the chat's history panel (a session file of the workspace). */
export interface SessionListItem {
	path: string;
	label: string;
	/** First line of the session's first prompt. */
	firstPrompt?: string;
	/** First line of its latest prompt; absent when that is the first one (see `singlePrompt`) or unknown. */
	lastPrompt?: string;
	/** The session has a single prompt. */
	singlePrompt: boolean;
	age: string;
	active: boolean;
	activity?: SessionActivity;
	/** A chat without a workspace (listed in the history panel's own section). */
	noWorkspace: boolean;
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
	/**
	 * Session snapshot; re-sent after every turn, model change, or session switch.
	 * `busySince` is when the session's running turn started (epoch ms), absent while idle.
	 * `noWorkspace`: a chat without a workspace (runs in the no-workspace folder).
	 */
	| {
			type: "state";
			state: SessionState;
			stats?: SessionStats;
			title?: string;
			busySince?: number;
			noWorkspace: boolean;
	  }
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
	| { type: "focusInput" }
	/** An `editMessage` was not resent (declined, vetoed, or failed): the webview reopens its editor. */
	| { type: "editAborted" }
	/**
	 * Dictation state from omp (recording, transcribing, idle), with a streaming
	 * model's running transcript in `text`; `error` when a capture failed.
	 */
	| { type: "dictation"; state: "recording" | "transcribing" | "idle"; text?: string; error?: string }
	/** omp's answer to a `predictWord` request: the rest of the word, or null for nothing to show. */
	| { type: "wordPrediction"; requestId: number; suffix: string | null }
	/** "Find in Chat" (Ctrl+F while the chat has focus): open the find bar. */
	| { type: "openFind" }
	/** A finished dictation: insert `text` at the cursor, and send it when `submit`. */
	| { type: "dictationText"; text: string; submit: boolean }
	/** The "Toggle Voice Input" command: start dictating, or stop and transcribe. */
	| { type: "toggleDictation" }
	/** Sessions of the workspace and then those without a workspace, each newest first (answer to `listSessions`). */
	| { type: "sessions"; sessions: SessionListItem[] }
	/** Activity of every session that is running or finished unseen, by session file; sent when it changes. */
	| { type: "sessionActivity"; activity: Record<string, SessionActivity> }
	/**
	 * omp asks to approve the plan it proposed: show it in the chat with `options`
	 * as buttons and answer with `planDecision`. `path` is the plan file on disk.
	 */
	| { type: "planReview"; id: string; title: string; content: string; path?: string; options: string[] }
	/** omp withdrew the plan review (the turn was aborted); disable its buttons. */
	| { type: "planReviewClosed"; id: string };

/** Chat webview → host. */
export type ChatRequest =
	/** Webview loaded; the host replies with status, history, state, models, commands. */
	| { type: "ready" }
	/** Send a prompt (with pasted images). While the agent is busy the host queues it (`ompCustom.sendWhileBusy`). */
	| { type: "prompt"; text: string; images?: ImageContent[] }
	/**
	 * Edit a prompt of the conversation and resend it: the session continues from
	 * there and everything after it leaves the conversation. `fromEnd` counts the
	 * prompts (`isUserPrompt`) after it (0 = the last one); `original` is its text as shown.
	 */
	| { type: "editMessage"; fromEnd: number; original: string; text: string }
	| { type: "abort" }
	/** Start a new chat; `noWorkspace` starts one without a workspace (see no-workspace.ts). */
	| { type: "newSession"; noWorkspace?: boolean }
	/** List the sessions for the history panel; the host answers with `sessions`. */
	| { type: "listSessions" }
	| { type: "openSession"; path: string }
	/** Rename the session at `path`, or the open one when `path` is absent; the host re-sends `sessions`. */
	| { type: "renameSession"; path?: string; name: string }
	/** Delete the session at `path` (named `label` in the confirmation); the host re-sends `sessions`. */
	| { type: "deleteSession"; path: string; label: string }
	/** Pick files with the open dialog and insert them as `@path` mentions. */
	| { type: "attachFiles" }
	| { type: "setModel"; provider: string; modelId: string }
	| { type: "setThinkingLevel"; level: ThinkingLevel }
	/** Enter or leave omp's plan mode, then send `prompt` if given (`/plan <prompt>`); the host replies with a fresh `state`. */
	| { type: "setPlanMode"; enabled: boolean; prompt?: string }
	/** Answer a `planReview` with one of its options. */
	| { type: "planDecision"; id: string; value: string }
	/** Open a plan file (absolute path) rendered in an editor tab. */
	| { type: "openPlan"; path: string }
	/** Revert one of omp's self-improvement edits to a skill (`omp skill revert <id>`), from its `skill-update` card. */
	| { type: "revertSkillUpdate"; id: string }
	| { type: "openSettings" }
	| { type: "login" }
	| { type: "compact" }
	| { type: "restart" }
	/** Open a file the transcript mentions; relative paths resolve against the workspace. */
	| { type: "openFile"; path: string; line?: number }
	| { type: "openExternal"; url: string }
	/** Remove a queued (not yet delivered) message. */
	| { type: "removeQueued"; message: string; queue: "steering" | "followUp" }
	/** Voice input: start recording, stop and transcribe, or drop the recording. */
	| { type: "dictation"; action: "start" | "stop" | "cancel" }
	/** Ghost text: predict the end of the word at `cursor` (a UTF-16 offset into `text`); answered by `wordPrediction`. */
	| { type: "predictWord"; requestId: number; text: string; cursor: number }
	/** A shown prediction was accepted (Tab/→) or typed past, for the engine to learn from. */
	| { type: "predictWordFeedback"; text: string; cursor: number; suggestion: string; accepted: boolean }
	/** Keyboard focus entered or left the webview (drives the Ctrl+F keybinding's context). */
	| { type: "focusChanged"; focused: boolean };

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
