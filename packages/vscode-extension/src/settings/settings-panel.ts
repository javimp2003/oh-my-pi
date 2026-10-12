/**
 * The omp settings editor tab: reads and writes settings through
 * `omp config list|set|reset --json`, so validation, layering, and the file
 * format stay omp's own.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { ompCommand, workspaceCwd } from "../config";
import type { SettingEntry, SettingsRequest, SettingsUpdate } from "../protocol";
import { webviewHtml } from "../webview-html";

/** Run `omp <args>` and resolve with stdout; rejects with omp's own error text. */
export function runOmp(args: readonly string[]): Promise<string> {
	const command = ompCommand(workspaceCwd());
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	execFile(
		command.executable,
		[...command.args, ...args],
		{ cwd: command.cwd, env: { ...process.env, ...command.env }, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
		(error, stdout, stderr) => {
			if (!error) {
				resolve(stdout);
				return;
			}
			const detail = (stderr || stdout).trim().replace(/^Error:\s*/, "");
			reject(
				new Error(
					(error as NodeJS.ErrnoException).code === "ENOENT"
						? `Could not find "${command.executable}". Set "ompCustom.executable".`
						: detail || error.message,
				),
			);
		},
	);
	return promise;
}

/** The global config file omp writes (`<agent dir>/config.yml`). */
export async function configFilePath(): Promise<string> {
	const agentDir = (await runOmp(["config", "path"])).trim();
	return path.join(agentDir, "config.yml");
}

export class SettingsPanel implements vscode.Disposable {
	static #current: SettingsPanel | undefined;

	static show(extensionUri: vscode.Uri): void {
		if (SettingsPanel.#current) {
			SettingsPanel.#current.#panel.reveal();
			return;
		}
		SettingsPanel.#current = new SettingsPanel(extensionUri);
	}

	readonly #panel: vscode.WebviewPanel;
	readonly #disposables: vscode.Disposable[] = [];

	private constructor(extensionUri: vscode.Uri) {
		this.#panel = vscode.window.createWebviewPanel("ompCustom.settings", "omp Settings", vscode.ViewColumn.Active, {
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist", "webview")],
		});
		this.#panel.iconPath = vscode.Uri.joinPath(extensionUri, "media", "icon.png");
		this.#panel.webview.html = webviewHtml(this.#panel.webview, extensionUri, "settings");
		this.#disposables.push(
			this.#panel.onDidDispose(() => this.dispose()),
			this.#panel.webview.onDidReceiveMessage((request: SettingsRequest) => void this.#handle(request)),
		);
	}

	dispose(): void {
		SettingsPanel.#current = undefined;
		for (const disposable of this.#disposables) disposable.dispose();
		this.#panel.dispose();
	}

	#post(update: SettingsUpdate): void {
		void this.#panel.webview.postMessage(update);
	}

	async #handle(request: SettingsRequest): Promise<void> {
		switch (request.type) {
			case "ready":
			case "refresh":
				await this.#sendSettings();
				return;
			case "set":
			case "reset": {
				const args =
					request.type === "set"
						? ["config", "set", request.key, request.value, "--json"]
						: ["config", "reset", request.key, "--json"];
				try {
					const result = JSON.parse(await runOmp(args)) as { value?: unknown };
					this.#post({ type: "saved", key: request.key, value: result.value });
				} catch (error) {
					this.#post({
						type: "saved",
						key: request.key,
						error: error instanceof Error ? error.message : String(error),
					});
				}
				return;
			}
			case "openConfigFile":
				await openConfigFile();
				return;
		}
	}

	async #sendSettings(): Promise<void> {
		try {
			const [list, configPath] = await Promise.all([runOmp(["config", "list", "--json"]), configFilePath()]);
			const parsed = JSON.parse(list) as Record<string, Omit<SettingEntry, "key">>;
			const entries = Object.entries(parsed).map(([key, entry]) => ({ key, ...entry }));
			this.#post({ type: "settings", entries, configPath });
		} catch (error) {
			this.#post({ type: "error", message: error instanceof Error ? error.message : String(error) });
		}
	}
}

/** Open the global config.yml, creating an empty one if omp has not written it yet. */
export async function openConfigFile(): Promise<void> {
	const file = await configFilePath();
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, "", { flag: "a" });
	await vscode.window.showTextDocument(vscode.Uri.file(file));
}
