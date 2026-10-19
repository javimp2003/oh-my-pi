/**
 * Chats without a workspace: omp runs in one fixed folder of their own
 * (`ompCustom.noWorkspaceFolder`, default `~/omp-sin-workspace`) instead of the
 * open workspace, so no project's file tree, AGENTS.md or memory reaches them,
 * and their sessions are grouped apart from every project's. The folder is the
 * same for every window and profile, so they all list the same chats.
 *
 * An `AGENTS.md` written there on first use tells the model these chats are for
 * general tasks; it is a plain project context file, so the user can edit it,
 * and an existing one is never overwritten.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type * as vscode from "vscode";
import { agentDir, readConfig } from "./config";
import { guessSessionDir } from "./sessions/session-store";

/** `globalState` key: omp's session directory per no-workspace folder, as seen on a session it opened. */
const SESSION_DIRS_KEY = "noWorkspaceSessionDirs";
let globalState: vscode.Memento | undefined;

/** Keep the session directories omp reports in `state` (shared by every window). */
export function bindNoWorkspaceState(state: vscode.Memento): void {
	globalState = state;
}

const AGENTS_MD = `# Chats without a workspace

This folder is the working directory of omp chats opened without a workspace
(the globe "+" in the VS Code chat). It is not a code project.

- Expect platform and operations work as much as general tasks: checking and
  changing cloud resources, dashboards, tickets, wiki pages, gateways and model
  registries through the matching skills; diagnosing this machine or its network;
  running commands and scripts; working with documents; answering questions.
  Do not look for or assume a codebase here.
- Save files the user asks for in this folder unless they give another path.

(Written by the omp VS Code extension. Edit it to change how these chats behave;
the extension never overwrites it.)
`;

/** The folder chats without a workspace run in: `ompCustom.noWorkspaceFolder` with `~` expanded. */
export function noWorkspaceFolder(): string {
	const configured = readConfig().noWorkspaceFolder;
	const expanded =
		configured === "~" || /^~[/\\]/.test(configured) ? path.join(os.homedir(), configured.slice(1)) : configured;
	return path.resolve(expanded);
}

/** Create the folder (and its AGENTS.md) if missing; resolves to the folder. */
export async function ensureNoWorkspaceFolder(): Promise<string> {
	const folder = noWorkspaceFolder();
	await fs.mkdir(folder, { recursive: true });
	await fs
		.writeFile(path.join(folder, "AGENTS.md"), AGENTS_MD, { flag: "wx" })
		.catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
	return folder;
}

/**
 * omp's session directory for chats without a workspace: the one omp used for
 * this folder, else a guess (`guessSessionDir` does not replicate every case of
 * omp's naming, such as temp folders).
 */
export function noWorkspaceSessionDir(): Promise<string> {
	const folder = noWorkspaceFolder();
	const known = globalState?.get<Record<string, string>>(SESSION_DIRS_KEY)?.[folder];
	return known ? Promise.resolve(known) : guessSessionDir(path.join(agentDir(), "sessions"), folder);
}

/** A chat without a workspace reported `sessionFile`: remember where omp keeps this folder's sessions. */
export function rememberNoWorkspaceSession(sessionFile: string): void {
	if (!globalState) return;
	const folder = noWorkspaceFolder();
	const dirs = globalState.get<Record<string, string>>(SESSION_DIRS_KEY) ?? {};
	const dir = path.dirname(sessionFile);
	if (dirs[folder] !== dir) void globalState.update(SESSION_DIRS_KEY, { ...dirs, [folder]: dir });
}

/** Whether `sessionFile` is a chat without a workspace. */
export async function isNoWorkspaceSession(sessionFile: string): Promise<boolean> {
	const dir = path.resolve(path.dirname(sessionFile));
	const expected = path.resolve(await noWorkspaceSessionDir());
	return process.platform === "win32" ? dir.toLowerCase() === expected.toLowerCase() : dir === expected;
}
