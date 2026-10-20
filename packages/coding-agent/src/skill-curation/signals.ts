/**
 * Which editable skills a finished task relied on.
 *
 * A skill is "loaded" once the conversation read one of its files (`read` of
 * `skill://<name>[/…]` or of a path inside the skill directory) or the user
 * invoked it (`/skill:<name>`); it stays loaded while that message is in the
 * live context. A task relied on a loaded skill when it read or invoked it,
 * used the skill's own files (scripts, references), or ran commands / reached
 * endpoints the skill's SKILL.md documents. Every such task gets a curation
 * turn — no tool error is required.
 */
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { Skill } from "../extensibility/skills";
import { convertToLlm, SKILL_PROMPT_MESSAGE_TYPE, type SkillPromptDetails } from "../session/messages";

/** How a task relied on a skill. */
export type SkillUse = "read" | "invoked" | "scripts" | "commands";

/** What a skill documents that a task can be seen using: program names and endpoint hosts (lower-case). */
export interface SkillAnchors {
	commands: ReadonlySet<string>;
	hosts: ReadonlySet<string>;
}

export interface CurationCandidate {
	skill: Skill;
	uses: SkillUse[];
	/** Up to five documented commands (`` `kubectl` ``) or hosts this task used. */
	matched: string[];
	/** The skill was first read or invoked in this task only after a tool had already failed: its description may not trigger in time. */
	readLate: boolean;
	/** The skill entered the conversation in an earlier task and was still in context: this task may lean on it without reading it again. */
	earlier: boolean;
}

export interface CurationSignals {
	candidates: CurationCandidate[];
	errorCount: number;
}

const SKILL_URL_PREFIX = "skill://";

/** The skill a `read` target belongs to, among `skills`: a `skill://` URL or a path inside a skill directory. */
export function matchSkillPath(target: string, skills: readonly Skill[], cwd: string): Skill | undefined {
	if (target.startsWith(SKILL_URL_PREFIX)) {
		const rest = target.slice(SKILL_URL_PREFIX.length);
		let match: Skill | undefined;
		for (const skill of skills) {
			const { name } = skill;
			const owns = rest === name || rest.startsWith(`${name}/`) || rest.startsWith(`${name}:`);
			if (owns && (!match || name.length > match.name.length)) match = skill;
		}
		return match;
	}
	// A trailing line selector (`SKILL.md:10-20`) keeps the path inside the directory.
	const absolute = path.resolve(cwd, target);
	return skills.find(skill => absolute === skill.filePath || absolute.startsWith(skill.baseDir + path.sep));
}

interface SkillLoad {
	skill: Skill;
	index: number;
	kind: "read" | "invoked";
	/** The `read` call that loaded it. */
	callId?: string;
}

function skillLoads(messages: readonly AgentMessage[], skills: readonly Skill[], cwd: string): SkillLoad[] {
	const loads: SkillLoad[] = [];
	messages.forEach((message, index) => {
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type !== "toolCall" || block.name !== "read") continue;
				const target = block.arguments.path;
				if (typeof target !== "string") continue;
				const skill = matchSkillPath(target, skills, cwd);
				if (skill) loads.push({ skill, index, kind: "read", callId: block.id });
			}
		} else if (message.role === "custom" && message.customType === SKILL_PROMPT_MESSAGE_TYPE) {
			const details = message.details as Partial<SkillPromptDetails> | undefined;
			const names = details?.skills?.map(entry => entry.name) ?? (details?.name ? [details.name] : []);
			for (const name of names) {
				const skill = skills.find(candidate => candidate.name === name);
				if (skill) loads.push({ skill, index, kind: "invoked" });
			}
		}
	});
	return loads;
}

/** Skills of `skills` that `messages` read or invoked, with the index where each was first loaded. */
export function loadedSkills(
	messages: readonly AgentMessage[],
	skills: readonly Skill[],
	cwd: string,
): Map<Skill, number> {
	const first = new Map<Skill, number>();
	for (const load of skillLoads(messages, skills, cwd)) if (!first.has(load.skill)) first.set(load.skill, load.index);
	return first;
}

/** Shell builtins, text utilities and interpreters: too common to tie a command to one skill. */
const GENERIC_COMMANDS: Record<string, true> = Object.fromEntries(
	[
		"cd",
		"ls",
		"dir",
		"cat",
		"type",
		"echo",
		"printf",
		"grep",
		"rg",
		"findstr",
		"sed",
		"awk",
		"head",
		"tail",
		"export",
		"set",
		"unset",
		"cp",
		"copy",
		"mv",
		"move",
		"rm",
		"del",
		"mkdir",
		"touch",
		"pwd",
		"which",
		"where",
		"sort",
		"uniq",
		"wc",
		"xargs",
		"tee",
		"true",
		"false",
		"test",
		"sleep",
		"exit",
		"if",
		"then",
		"else",
		"fi",
		"for",
		"do",
		"done",
		"while",
		"case",
		"esac",
		"function",
		"return",
		"read",
		"clear",
		"less",
		"more",
		"find",
		"chmod",
		"chown",
		"ln",
		"tr",
		"cut",
		"diff",
		"date",
		"source",
		"bash",
		"sh",
		"zsh",
		"pwsh",
		"powershell",
		"cmd",
		"node",
		"bun",
		"deno",
		"python",
		"python3",
		"py",
		"start",
		"open",
	].map(name => [name, true]),
);
const COMMAND_WRAPPERS: Record<string, true> = { sudo: true, time: true, env: true, nohup: true, exec: true };
const SHELL_FENCES: Record<string, true> = Object.fromEntries(
	["", "sh", "bash", "shell", "zsh", "console", "terminal", "powershell", "ps1", "pwsh", "cmd", "bat"].map(info => [
		info,
		true,
	]),
);
const PROMPT_RE = /^\s*(?:PS(?: [^>]*)?>|\$|>)\s+/;
const SEGMENT_SPLIT_RE = /&&|\|\||[|;\n`]|\$\(/;
const FENCE_RE = /^(```|~~~)[ \t]*([\w+-]*)[^\n]*\n([\s\S]*?)^\1[ \t]*$/gm;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const HOST_RE = /https?:\/\/([^/\s"'`)>\]]+)/gi;
const ANCHOR_RE = /^[a-z][\w.+-]+$/;

/** The program each command in `text` runs: env assignments and wrappers (`sudo`, `env`…) skipped, basename, lower-case. */
export function commandHeads(text: string): string[] {
	const heads: string[] = [];
	for (const line of text.split("\n")) {
		for (const segment of line.replace(PROMPT_RE, "").split(SEGMENT_SPLIT_RE)) {
			const tokens = segment.trim().split(/\s+/);
			let index = 0;
			while (
				index < tokens.length &&
				(/^\w+=/.test(tokens[index]) || COMMAND_WRAPPERS[tokens[index].toLowerCase()])
			) {
				index++;
			}
			const token = tokens[index]?.replace(/^["'(]+|["')]+$/g, "");
			if (!token) continue;
			const head = (token.split(/[\\/]/).pop() ?? "").replace(/\.(exe|cmd|bat|ps1|sh)$/i, "").toLowerCase();
			if (head) heads.push(head);
		}
	}
	return heads;
}

/** What `skillMd` documents: programs its shell code runs and hosts its URLs name. */
export function skillAnchors(skillMd: string): SkillAnchors {
	let body = skillMd;
	try {
		body = parseFrontmatter(skillMd, { source: "SKILL.md", level: "off", repair: false }).body;
	} catch {
		// Unparseable frontmatter: scan the whole file.
	}
	const code: string[] = [];
	const prose = body.replace(FENCE_RE, (_match, _fence: string, info: string, content: string) => {
		if (SHELL_FENCES[info.toLowerCase()]) code.push(content);
		return "";
	});
	for (const match of prose.matchAll(INLINE_CODE_RE)) code.push(match[1]);
	const commands = new Set<string>();
	for (const head of commandHeads(code.join("\n"))) {
		if (ANCHOR_RE.test(head) && !GENERIC_COMMANDS[head]) commands.add(head);
	}
	const hosts = new Set<string>();
	for (const match of body.matchAll(HOST_RE)) hosts.add(match[1].toLowerCase());
	return { commands, hosts };
}

/** How tool arguments can name the skill directory: as is, in Git Bash form (`/c/…`), under `~`, or as `skill://`. */
function skillPathNeedles(skill: Skill): string[] {
	const base = skill.baseDir.replaceAll("\\", "/").toLowerCase();
	const needles = [base, `skill://${skill.name.toLowerCase()}`];
	const drive = /^([a-z]):\//.exec(base);
	if (drive) needles.push(`/${drive[1]}/${base.slice(3)}`);
	const home = os.homedir().replaceAll("\\", "/").toLowerCase();
	if (base.startsWith(`${home}/`)) needles.push(`~${base.slice(home.length)}`);
	return needles;
}

function collectStrings(value: unknown, out: string[]): void {
	if (typeof value === "string") out.push(value);
	else if (Array.isArray(value)) for (const item of value) collectStrings(item, out);
	else if (value && typeof value === "object") for (const item of Object.values(value)) collectStrings(item, out);
}

const USE_ORDER: readonly SkillUse[] = ["read", "invoked", "scripts", "commands"];
const MAX_MATCHED = 5;

/**
 * Curation candidates for the task that starts at `messages[taskStart]`.
 * `messages` is the session's live context: a skill an earlier task loaded
 * still counts while it stays in context (compaction drops it). Every loaded
 * skill in `skills` this task relied on is a candidate; `anchors` holds what
 * each SKILL.md documents. A failed read of a skill file is not a task failure.
 */
export function collectCurationSignals(
	messages: readonly AgentMessage[],
	taskStart: number,
	skills: readonly Skill[],
	cwd: string,
	anchors: ReadonlyMap<Skill, SkillAnchors>,
): CurationSignals | undefined {
	const firstLoad = new Map<Skill, number>();
	const skillReadCallIds = new Set<string>();
	const usage = new Map<Skill, { uses: Set<SkillUse>; matched: Set<string>; loadInTask?: number }>();
	const use = (skill: Skill) => {
		let entry = usage.get(skill);
		if (!entry) {
			entry = { uses: new Set(), matched: new Set() };
			usage.set(skill, entry);
		}
		return entry;
	};
	for (const load of skillLoads(messages, skills, cwd)) {
		if (load.callId) skillReadCallIds.add(load.callId);
		if (!firstLoad.has(load.skill)) firstLoad.set(load.skill, load.index);
		if (load.index < taskStart) continue;
		const entry = use(load.skill);
		entry.uses.add(load.kind);
		entry.loadInTask ??= load.index;
	}
	if (firstLoad.size === 0) return undefined;
	const needles = new Map([...firstLoad.keys()].map(skill => [skill, skillPathNeedles(skill)]));
	const errors: number[] = [];
	for (let index = taskStart; index < messages.length; index++) {
		const message = messages[index];
		if (message.role === "toolResult") {
			if (message.isError && !skillReadCallIds.has(message.toolCallId)) errors.push(index);
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type !== "toolCall" || skillReadCallIds.has(block.id)) continue;
			// JSON escapes `\` as `\\`: fold both to `/` so Windows paths compare like POSIX ones.
			const haystack = JSON.stringify(block.arguments).replaceAll("\\\\", "/").toLowerCase();
			const strings: string[] = [];
			collectStrings(block.arguments, strings);
			const heads = commandHeads(strings.join("\n"));
			for (const [skill, loadedAt] of firstLoad) {
				// A call made before the skill entered the conversation did not follow it.
				if (loadedAt > index) continue;
				if (needles.get(skill)?.some(needle => haystack.includes(needle))) use(skill).uses.add("scripts");
				const documented = anchors.get(skill);
				if (!documented) continue;
				for (const head of heads) {
					if (!documented.commands.has(head)) continue;
					const entry = use(skill);
					entry.uses.add("commands");
					entry.matched.add(`\`${head}\``);
				}
				for (const host of documented.hosts) {
					if (!haystack.includes(host)) continue;
					const entry = use(skill);
					entry.uses.add("commands");
					entry.matched.add(host);
				}
			}
		}
	}
	const candidates: CurationCandidate[] = [];
	for (const [skill, loadedAt] of firstLoad) {
		const entry = usage.get(skill);
		if (!entry || entry.uses.size === 0) continue;
		candidates.push({
			skill,
			uses: USE_ORDER.filter(kind => entry.uses.has(kind)),
			matched: [...entry.matched].slice(0, MAX_MATCHED),
			readLate: entry.loadInTask !== undefined && errors[0] !== undefined && errors[0] < entry.loadInTask,
			earlier: loadedAt < taskStart,
		});
	}
	return candidates.length > 0 ? { candidates, errorCount: errors.length } : undefined;
}

type Block = Exclude<Message["content"], string>[number];

/** A content block as transcript text; thinking is omitted, images are marked. */
function blockText(block: Block): string | undefined {
	switch (block.type) {
		case "text":
			return block.text;
		case "image":
			return "[image]";
		case "toolCall":
			return `CALL ${block.name}: ${JSON.stringify(block.arguments)}`;
		default:
			return undefined;
	}
}

function contentText(content: Message["content"]): string {
	if (typeof content === "string") return content;
	const parts: string[] = [];
	for (const block of content) {
		const text = blockText(block);
		if (text !== undefined) parts.push(text);
	}
	return parts.join("\n");
}

/**
 * What a curation turn sees of a finished task: every message the model saw
 * during it, in order and unabridged — user prompts (with invoked skills
 * expanded), the assistant's text and tool calls, and every tool result. Only
 * the assistant's thinking is left out.
 */
export function renderTaskTranscript(messages: readonly AgentMessage[]): string {
	const lines: string[] = [];
	for (const message of convertToLlm([...messages])) {
		if (message.role === "user" || message.role === "developer") {
			lines.push(`USER: ${contentText(message.content)}`);
		} else if (message.role === "assistant") {
			for (const block of message.content) {
				const text = blockText(block);
				if (text === undefined || !text.trim()) continue;
				lines.push(block.type === "toolCall" ? text : `ASSISTANT: ${text}`);
			}
		} else if (message.role === "toolResult") {
			lines.push(`${message.isError ? "ERROR" : "RESULT"} ${message.toolName}: ${contentText(message.content)}`);
		}
	}
	return lines.join("\n");
}
