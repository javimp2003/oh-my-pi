import * as path from "node:path";
import { createMockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runRpcMode } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-mode";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgAsyncEnabled } from "@oh-my-pi/pi-coding-agent/tools/settings";

// Real SDK session and RPC dispatch; only the model is scripted. Every prompt turn
// drafts `local://PLAN.md` with `write`, then submits it with a `write` to
// `xd://propose`, then ends with text.
const cwd = process.cwd();
const authStorage = await AuthStorage.create(path.join(cwd, "auth.db"));
authStorage.keys.setRuntime("anthropic", "test-key");
const modelRegistry = new ModelRegistry(authStorage, path.join(cwd, "models.yml"));
const settings = await Settings.init({ inMemory: true, cwd });
cfgAsyncEnabled.set(settings, false);
const { session } = await createAgentSession({
	cwd,
	agentDir: cwd,
	// File-backed: plan files live in the session's `local://` artifacts root.
	sessionManager: SessionManager.create(cwd),
	authStorage,
	modelRegistry,
	settings,
	model: getBundledModel("anthropic", "claude-sonnet-4-5"),
	disableExtensionDiscovery: true,
	skills: [],
	contextFiles: [],
	workspaceTree: { rootPath: cwd, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	promptTemplates: [],
	slashCommands: [],
	enableMCP: false,
	enableLsp: false,
});
let turn = 0;
const script = (): MockResponse => {
	const step = turn++ % 3;
	if (step === 0) {
		return {
			content: [
				{
					type: "toolCall",
					id: `w${turn}`,
					name: "write",
					arguments: { path: "local://PLAN.md", content: "# Plan\n\n1. Do the thing.\n" },
				},
			],
		};
	}
	if (step === 1) {
		return {
			content: [
				{
					type: "toolCall",
					id: `p${turn}`,
					name: "write",
					arguments: { path: "xd://propose", content: "Do the thing" },
				},
			],
		};
	}
	return { content: ["Done."] };
};
const mock = createMockModel({ handler: script });
session.agent.streamFn = mock.stream;
await runRpcMode(session);
