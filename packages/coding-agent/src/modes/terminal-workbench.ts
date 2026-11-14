import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { WorkbenchComponent } from "@oh-my-pi/pi-tui/overlays/workbench";
import type { InteractiveModeContext } from "./types";

interface WorkbenchAction {
	label: string;
	description: string;
	command: string;
	input?: string;
}

/** UI routes only: every action still runs through the normal slash-command dispatcher. */
const ACTIONS: readonly WorkbenchAction[] = [
	{ label: "Chat / New conversation", description: "Start a fresh conversation in this workspace", command: "/new" },
	{ label: "Chat / History", description: "Search, resume, rename or delete saved conversations", command: "/resume" },
	{
		label: "Chat / Rename",
		description: "Give the current conversation a name",
		command: "/rename",
		input: "Conversation name",
	},
	{
		label: "Chat / Edit an earlier prompt",
		description: "Choose a prompt and continue on a new branch",
		command: "/branch",
	},
	{ label: "Chat / Conversation tree", description: "Browse earlier branches and messages", command: "/tree" },
	{ label: "Chat / Session details", description: "Current session information and statistics", command: "/session" },
	{ label: "Model / Choose model", description: "Select the model and provider", command: "/model" },
	{
		label: "Model / Reasoning effort",
		description: "Choose an effort supported by the current model",
		command: "/effort",
	},
	{ label: "Modes / Plan", description: "Toggle planning and review the plan before execution", command: "/plan" },
	{ label: "Modes / Delegate", description: "Toggle execution through subagents", command: "/delegate" },
	{ label: "Context / Usage and cost", description: "Provider usage, limits and session cost", command: "/usage" },
	{ label: "Context / Inspect context", description: "See what occupies the model context", command: "/context" },
	{
		label: "Context / Compact",
		description: "Summarize older history while retaining recent messages",
		command: "/compact",
	},
	{
		label: "Context / Clean up",
		description: "Drop bulky tool results and large blocks without summarizing",
		command: "/shake",
	},
	{ label: "Context / Handoff", description: "Prepare a handoff and continue from it", command: "/handoff" },
	{ label: "Agents / Live activity", description: "Inspect active agents and focus their sessions", command: "/hub" },
	{ label: "Agents / Configuration", description: "Agent models, prewalk and advisors", command: "/agents" },
	{ label: "Agents / Background jobs", description: "View asynchronous tasks and command output", command: "/jobs" },
	{ label: "Agents / Todo list", description: "View the task's progress and next steps", command: "/todo" },
	{ label: "Tools / Available tools", description: "Inspect the tools available to the model", command: "/tools" },
	{
		label: "Tools / Extensions and skills",
		description: "Inspect discovered skills, extensions and their sources",
		command: "/extensions",
	},
	{
		label: "Tools / Skill edit history",
		description: "Inspect skill self-improvement changes",
		command: "/skill-history",
	},
	{ label: "Tools / MCP", description: "Inspect and manage connected MCP servers", command: "/mcp" },
	{ label: "Files / Changes", description: "Browse the repository and inspect diffs", command: "/git" },
	{
		label: "Settings / All settings",
		description: "Search every configuration key, edit values and reset overrides",
		command: "/settings",
	},
	{ label: "Settings / Provider setup", description: "Configure providers and sign-in", command: "/setup" },
	{ label: "Settings / Log in", description: "Sign in to a model provider", command: "/login" },
	{ label: "Settings / Log out", description: "Choose a provider account to sign out", command: "/logout" },
	{
		label: "Help / Keyboard shortcuts",
		description: "Attachments, dictation, search and transcript controls",
		command: "/hotkeys",
	},
];

type WorkbenchContext = Pick<
	InteractiveModeContext,
	"session" | "sessionManager" | "sessionName" | "showHookCustom" | "showHookInput"
>;

/** Pick a normal command, without changing the session until the user chooses an action. */
export async function chooseWorkbenchCommand(ctx: WorkbenchContext): Promise<string | undefined> {
	const model = ctx.session.model;
	const workspace = shortenPath(ctx.sessionManager.getCwd());
	const state = ctx.session.isStreaming ? "working" : "ready";
	const selected = await ctx.showHookCustom<string | undefined>(
		(tui, _theme, _keys, done) =>
			new WorkbenchComponent({
				items: ACTIONS.map(action => {
					const [category, ...label] = action.label.split(" / ");
					return {
						id: action.command,
						category: category ?? "Other",
						label: label.join(" / "),
						description: action.description,
						command: action.command,
					};
				}),
				session: ctx.sessionName ?? "New conversation",
				workspace,
				model: model ? `${model.provider ?? ""}/${model.id}` : "No model selected",
				state,
				getHeight: () => tui.terminal.rows,
				onSelect: done,
				onCancel: () => done(undefined),
			}),
		{
			overlay: true,
			overlayOptions: { fullscreen: true, width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 },
		},
	);
	const action = ACTIONS.find(candidate => candidate.command === selected);
	if (!action) return undefined;
	if (!action.input) return action.command;
	const value = await ctx.showHookInput(action.input);
	return value?.trim() ? `${action.command} ${value.trim().replace(/[\r\n]+/g, " ")}` : undefined;
}
