/**
 * Chat webview entry: mounts header, transcript, and composer into `#root` and
 * routes host `ChatUpdate`s to them.
 */
import type { AgentStatus, ChatRequest, ChatUpdate } from "../../src/protocol";
import { getVsCodeApi } from "../vscode-api";
import { Composer } from "./composer";
import { button, h } from "../dom";
import { Header } from "./header";
import { Transcript } from "./transcript";

interface ChatViewState {
	draft?: string;
}

const vscode = getVsCodeApi<ChatRequest, ChatViewState>();
const post = (request: ChatRequest) => vscode.postMessage(request);

const header = new Header(post);
const composer = new Composer(post, draft => vscode.setState({ draft }), vscode.getState()?.draft ?? "");
const transcript = new Transcript(post, prompt => composer.fill(prompt));

const statusLabel = h("div", { className: "status-label" });
const statusMessage = h("pre", { className: "status-message" });
const restart = button("Restart", "primary-button", () => post({ type: "restart" }));
const statusPanel = h(
	"div",
	{ className: "status-overlay" },
	h(
		"div",
		{ className: "status-card" },
		h("span", { className: "spinner large" }),
		statusLabel,
		statusMessage,
		restart,
	),
);

const root = document.getElementById("root")!;
root.classList.add("chat");
root.append(header.element, h("div", { className: "main" }, transcript.element, statusPanel), composer.element);

let busy = false;
function setBusy(next: boolean): void {
	if (busy === next) return;
	busy = next;
	transcript.setBusy(next);
	composer.setBusy(next);
}

function setStatus(status: AgentStatus): void {
	statusPanel.dataset.phase = status.phase;
	statusPanel.hidden = status.phase === "ready";
	statusLabel.textContent = status.phase === "starting" ? "Starting omp…" : "omp is not running";
	statusMessage.textContent = status.phase === "stopped" ? status.message : "";
	statusMessage.hidden = status.phase !== "stopped";
	restart.hidden = status.phase !== "stopped";
	composer.setEnabled(status.phase === "ready");
	if (status.phase !== "ready") setBusy(false);
}

function handle(update: ChatUpdate): void {
	switch (update.type) {
		case "status":
			setStatus(update.status);
			break;
		case "history":
			transcript.setHistory(update.messages);
			break;
		case "event": {
			const { event } = update;
			switch (event.type) {
				case "agent_start":
					setBusy(true);
					break;
				case "agent_end":
					transcript.handleEvent(event);
					setBusy(false);
					break;
				case "queue_update":
					composer.setQueue(event.steering, event.followUp, event.liveSteered);
					break;
				case "notice":
					composer.showNotice(event.level, event.message);
					break;
				case "thinking_level_changed":
					if (event.thinkingLevel) header.setThinkingLevel(event.thinkingLevel);
					break;
				default:
					transcript.handleEvent(event);
			}
			break;
		}
		case "state": {
			const { state } = update;
			header.setState(state, update.stats, update.title);
			if (state.isStreaming !== undefined) setBusy(state.isStreaming);
			if (state.queuedMessages) {
				const queued = state.queuedMessages;
				composer.setQueue(queued.steering, queued.followUp, queued.liveSteered);
			}
			break;
		}
		case "models":
			header.setModels(update.models);
			break;
		case "thinkingLevels":
			header.setThinkingLevels(update.levels);
			break;
		case "commands":
			composer.setCommands(update.commands);
			break;
		case "commandOutput":
			transcript.appendCommandOutput(update.text);
			break;
		case "notice":
			composer.showNotice(update.level, update.message);
			break;
		case "insertText":
			composer.insertText(update.text);
			break;
		case "focusInput":
			composer.focus();
			break;
	}
}

window.addEventListener("message", (event: MessageEvent<ChatUpdate>) => handle(event.data));
setStatus({ phase: "starting" });
post({ type: "ready" });
