import * as vscode from "vscode";
import { ompCommand, workspaceCwd } from "../config";
import { OmpProcess } from "../rpc/omp-process";

/**
 * Rename a session no chat has open: resume it in a short-lived omp process and
 * set its name there, so omp writes the title exactly as `/rename` would.
 */
export async function renameStoredSession(sessionFile: string, name: string, log: vscode.OutputChannel): Promise<void> {
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: "omp: renaming session…" },
		async () => {
			const process = new OmpProcess(ompCommand(workspaceCwd()));
			process.on("stderr", text => log.append(text));
			try {
				await process.start(["--resume", sessionFile]);
				await process.request("set_session_name", { name });
			} finally {
				await process.stop();
			}
		},
	);
}
