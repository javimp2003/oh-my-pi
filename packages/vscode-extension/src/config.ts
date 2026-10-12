import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { OmpCommand } from "./rpc/omp-process";

/** The `ompCustom.*` settings, read fresh on every use so edits apply to the next process. */
export function readConfig() {
	const config = vscode.workspace.getConfiguration("ompCustom");
	return {
		executable: config.get<string>("executable", "omp").trim() || "omp",
		args: config.get<string[]>("args", []),
		extraArgs: config.get<string[]>("extraArgs", []),
		env: config.get<Record<string, string>>("env", {}),
		resumeLastSession: config.get<boolean>("resumeLastSession", true),
		sendWhileBusy: config.get<"steer" | "followUp">("sendWhileBusy", "steer"),
	};
}

/** The workspace folder omp works in: the active editor's folder, else the first one, else home. */
export function workspaceCwd(): string {
	const active = vscode.window.activeTextEditor?.document.uri;
	const folder =
		(active && vscode.workspace.getWorkspaceFolder(active)) ?? vscode.workspace.workspaceFolders?.[0] ?? undefined;
	return folder?.uri.fsPath ?? os.homedir();
}

export function ompCommand(cwd: string): OmpCommand {
	const { executable, args, env } = readConfig();
	// Keep session titles (RPC skips them by default) so the sessions list reads well.
	return { executable, args, env: { PI_RPC_AUTO_TITLE: "1", ...env }, cwd };
}

/** omp's agent directory (`PI_CODING_AGENT_DIR`, default `~/.omp/agent`), honoring `ompCustom.env`. */
export function agentDir(): string {
	const configured = readConfig().env.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR;
	return configured ? path.resolve(configured) : path.join(os.homedir(), ".omp", "agent");
}
