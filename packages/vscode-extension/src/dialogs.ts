/**
 * omp's extension UI sub-protocol (`extension_ui_request`) rendered with
 * native VS Code prompts: the `ask` tool, tool confirmations, OAuth login
 * URLs, notifications, and status text.
 */
import * as vscode from "vscode";
import type {
	AskAnswer,
	AskQuestion,
	ExtensionUiRequest,
	ExtensionUiResponse,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/wire/rpc-wire.generated";
import { startAskAlert } from "./sounds";

export interface DialogHost {
	respond(response: ExtensionUiResponse): void;
	/** Show extension status text (`setStatus`); `undefined` clears the key. */
	setStatus(key: string, text: string | undefined): void;
	/** Replace the composer draft (`set_editor_text`). */
	setEditorText(text: string): void;
	log(line: string): void;
	/**
	 * Show omp's plan-approval `select` with the plan itself (the chat's plan card);
	 * resolves to the chosen option, or undefined when dismissed or `token` is cancelled.
	 */
	reviewPlan(request: SelectRequest, token: vscode.CancellationToken): Promise<string | undefined>;
}

const CUSTOM_ANSWER = "$(edit) Other (type your own)…";
/** Selects with a multi-line title and at most this many options render as a modal with buttons. */
const MAX_MODAL_OPTIONS = 3;
/** omp's plan-approval options (`packages/coding-agent/src/modes/rpc/rpc-plan.ts`). */
const PLAN_APPROVE_OPTION = "Approve and execute";
const PLAN_REFINE_OPTION = "Refine plan";

export type SelectRequest = Extract<ExtensionUiRequest, { method: "select" }>;

function isPlanApproval(options: readonly string[]): boolean {
	return options.length === 2 && options[0] === PLAN_APPROVE_OPTION && options[1] === PLAN_REFINE_OPTION;
}

/** Open dialogs by request id, so a `cancel` can close them. */
export class DialogBridge {
	readonly #open = new Map<string, vscode.CancellationTokenSource>();

	constructor(readonly host: DialogHost) {}

	handle(request: ExtensionUiRequest): void {
		switch (request.method) {
			case "select":
			case "confirm":
			case "input":
			case "editor":
			case "ask":
				void this.#answer(request);
				return;
			case "cancel":
				this.#open.get(request.targetId)?.cancel();
				return;
			case "notify": {
				const show =
					request.notifyType === "error"
						? vscode.window.showErrorMessage
						: request.notifyType === "warning"
							? vscode.window.showWarningMessage
							: vscode.window.showInformationMessage;
				void show(`omp: ${request.message}`);
				return;
			}
			case "setStatus":
				this.host.setStatus(request.statusKey, request.statusText);
				return;
			case "set_editor_text":
				this.host.setEditorText(request.text);
				return;
			case "open_url":
				void this.#openUrl(request.url, request.launchUrl, request.instructions);
				return;
			case "setWidget":
			case "setTitle":
				// Terminal-only presentation; nothing to show in VS Code.
				return;
		}
	}

	/** Cancel every open dialog (the process exited). */
	dispose(): void {
		for (const source of this.#open.values()) source.cancel();
		this.#open.clear();
	}

	async #answer(request: Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" | "ask" }>) {
		const source = new vscode.CancellationTokenSource();
		this.#open.set(request.id, source);
		const alert =
			request.method === "ask" || (request.method === "select" && isPlanApproval(request.options))
				? startAskAlert(line => this.host.log(line))
				: undefined;
		const token = source.token;
		try {
			const response = await this.#prompt(request, token);
			if (token.isCancellationRequested) return;
			this.host.respond(response ?? { type: "extension_ui_response", id: request.id, cancelled: true });
		} catch (error) {
			this.host.log(`dialog ${request.method} failed: ${String(error)}`);
			this.host.respond({ type: "extension_ui_response", id: request.id, cancelled: true });
		} finally {
			alert?.dispose();
			this.#open.delete(request.id);
			source.dispose();
		}
	}

	async #prompt(
		request: Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" | "ask" }>,
		token: vscode.CancellationToken,
	): Promise<ExtensionUiResponse | undefined> {
		const id = request.id;
		switch (request.method) {
			case "select": {
				if (isPlanApproval(request.options)) {
					const value = await this.host.reviewPlan(request, token);
					return value === undefined ? undefined : { type: "extension_ui_response", id, value };
				}
				// A multi-line title does not fit a QuickPick title; a modal shows it in full
				// with the options as buttons.
				const [heading = "", ...body] = request.title.split("\n");
				if (body.length > 0 && request.options.length <= MAX_MODAL_OPTIONS) {
					const picked = await vscode.window.showInformationMessage(
						heading,
						{ modal: true, detail: body.join("\n").trim() },
						...request.options,
					);
					return picked === undefined ? undefined : { type: "extension_ui_response", id, value: picked };
				}
				const items = request.options.map((label, index) => ({
					label,
					detail: request.optionDetails?.[index]?.description,
				}));
				const picked = await vscode.window.showQuickPick(
					items,
					{ title: request.title, ignoreFocusOut: true },
					token,
				);
				return picked && { type: "extension_ui_response", id, value: picked.label };
			}
			case "confirm": {
				const choice = await vscode.window.showWarningMessage(
					request.title,
					{ modal: true, detail: request.message },
					"Yes",
				);
				return { type: "extension_ui_response", id, confirmed: choice === "Yes" };
			}
			case "input":
			case "editor": {
				const value = await vscode.window.showInputBox(
					{
						title: request.title,
						prompt: request.method === "input" ? request.placeholder : undefined,
						value: request.method === "editor" ? request.prefill : undefined,
						ignoreFocusOut: true,
					},
					token,
				);
				return value === undefined ? undefined : { type: "extension_ui_response", id, value };
			}
			case "ask": {
				const answers: AskAnswer[] = [];
				for (const [index, question] of request.questions.entries()) {
					const answer = await askQuestion(question, `${index + 1}/${request.questions.length}`, token);
					if (!answer) return undefined;
					answers.push(answer);
				}
				return { type: "extension_ui_response", id, answers };
			}
		}
	}

	async #openUrl(url: string, launchUrl: string | undefined, instructions: string | undefined): Promise<void> {
		const target = launchUrl ?? url;
		const opened = await vscode.env.openExternal(vscode.Uri.parse(target, true));
		const message = instructions ?? "Finish signing in in your browser.";
		const action = await vscode.window.showInformationMessage(
			`omp: ${message}`,
			opened ? "Copy Link" : "Open Link",
			...(opened ? [] : ["Copy Link"]),
		);
		if (action === "Copy Link") await vscode.env.clipboard.writeText(target);
		if (action === "Open Link") await vscode.env.openExternal(vscode.Uri.parse(target, true));
	}
}

/** One `ask` question as a QuickPick, with free text always offered besides the options. */
async function askQuestion(
	question: AskQuestion,
	step: string,
	token: vscode.CancellationToken,
): Promise<AskAnswer | undefined> {
	const items: vscode.QuickPickItem[] = question.options.map((option, index) => ({
		label: option.label,
		description: index === question.recommended ? "(recommended)" : undefined,
		detail: option.description,
		picked: question.multi ? index === question.recommended : undefined,
	}));
	items.push({ label: CUSTOM_ANSWER, alwaysShow: true });
	const title = question.header ? `${question.header} (${step})` : `omp asks (${step})`;
	const picked = question.multi
		? await vscode.window.showQuickPick(
				items,
				{ title, placeHolder: question.question, canPickMany: true, ignoreFocusOut: true },
				token,
			)
		: await vscode.window
				.showQuickPick(items, { title, placeHolder: question.question, ignoreFocusOut: true }, token)
				.then(item => (item ? [item] : undefined));
	if (!picked) return undefined;
	const selectedOptions = picked.filter(item => item.label !== CUSTOM_ANSWER).map(item => item.label);
	if (!picked.some(item => item.label === CUSTOM_ANSWER)) return { id: question.id, selectedOptions };
	const customInput = await vscode.window.showInputBox(
		{ title, prompt: question.question, ignoreFocusOut: true },
		token,
	);
	if (customInput === undefined) return undefined;
	return { id: question.id, selectedOptions, customInput };
}
