/**
 * Sounds on the machine running omp (the extension host's): the completion
 * sound when a turn finishes, so a task left running is noticed, and the
 * spoken ask alert while omp waits for an answer (an `ask` question or a plan
 * approval). The OS's own player plays the file; nothing is decoded or kept in
 * memory here, and the player exits when the sound ends.
 */
import { spawn } from "node:child_process";
import * as vscode from "vscode";
import { readConfig } from "./config";

export type SoundMode = "always" | "windowUnfocused" | "off";

/** Player command and arguments; a queue is tried in order, the next only when one is missing or fails. */
type Player = [string, string[]];

/** Several sessions finishing (or asking) together make one sound. */
const MIN_INTERVAL_MS = 1500;
let lastCompletion = 0;

/** Repeats while a question or plan approval is still pending. */
const ASK_ALERT_REPEAT_MS = 60_000;
let askAlertFile: string | undefined;
let pendingAsks = 0;
let askTimer: NodeJS.Timeout | undefined;
let lastAskAlert = 0;

/** Called once from `activate`: where the bundled recording lives. */
export function initSounds(extensionUri: vscode.Uri): void {
	askAlertFile = vscode.Uri.joinPath(extensionUri, "media", "ask-alert.mp3").fsPath;
}

/** The OS's own completion sound. */
function completionPlayers(): Player[] {
	switch (process.platform) {
		case "darwin":
			return [["afplay", ["/System/Library/Sounds/Glass.aiff"]]];
		case "win32":
			return [
				[
					"powershell.exe",
					[
						"-NoProfile",
						"-NonInteractive",
						"-Command",
						'(New-Object Media.SoundPlayer "$env:WINDIR\\Media\\Windows Notify System Generic.wav").PlaySync()',
					],
				],
			];
		default:
			return [
				["paplay", ["/usr/share/sounds/freedesktop/stereo/complete.oga"]],
				["canberra-gtk-play", ["--id", "complete"]],
			];
	}
}

/** Players for an MP3 file. */
function filePlayers(file: string): Player[] {
	switch (process.platform) {
		case "darwin":
			return [["afplay", [file]]];
		case "win32": {
			// A single-quoted PowerShell literal: only `'` needs escaping (doubled).
			const literal = file.replaceAll("'", "''");
			const script =
				`if (-not (Test-Path -LiteralPath '${literal}')) { exit 1 }; ` +
				`$w = New-Object -ComObject WMPlayer.OCX; $w.URL = '${literal}'; $w.controls.play(); ` +
				"$t = 0; while ($w.playState -ne 1 -and $t -lt 300) { Start-Sleep -Milliseconds 100; $t++ }; $w.close()";
			return [["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script]]];
		}
		default:
			return [
				["ffplay", ["-nodisp", "-autoexit", "-loglevel", "quiet", file]],
				["mpg123", ["-q", file]],
				["paplay", [file]],
			];
	}
}

/** Runs the first player that works; `onFail` when none does. */
function play(queue: Player[], onFail?: () => void): void {
	const [next, ...rest] = queue;
	if (!next) {
		onFail?.();
		return;
	}
	const child = spawn(next[0], next[1], { stdio: "ignore", windowsHide: true });
	// `exit` may follow `error`; fall through to the next player once.
	let failed = false;
	const fail = () => {
		if (failed) return;
		failed = true;
		play(rest, onFail);
	};
	child.once("error", fail);
	child.once("exit", code => {
		if (code !== 0) fail();
	});
	child.unref();
}

function allowed(mode: SoundMode): boolean {
	return mode !== "off" && (mode !== "windowUnfocused" || !vscode.window.state.focused);
}

/** Plays the sound for a finished turn, as `mode` allows. */
export function playCompletionSound(mode: SoundMode): void {
	if (!allowed(mode)) return;
	const now = Date.now();
	if (now - lastCompletion < MIN_INTERVAL_MS) return;
	lastCompletion = now;
	play(completionPlayers());
}

/**
 * Alert for one pending question (an `ask` or a plan approval): plays the
 * recording now and every minute while any is pending; dispose once answered
 * or cancelled. Concurrent questions share one repeat timer.
 */
export function startAskAlert(log: (line: string) => void): vscode.Disposable {
	pendingAsks++;
	playAskAlert(log);
	askTimer ??= setInterval(() => playAskAlert(log), ASK_ALERT_REPEAT_MS);
	let disposed = false;
	return {
		dispose() {
			if (disposed) return;
			disposed = true;
			pendingAsks--;
			if (pendingAsks > 0) return;
			clearInterval(askTimer);
			askTimer = undefined;
		},
	};
}

/** The setting is read on every play, so turning it off also stops a pending alert's repeats. */
function playAskAlert(log: (line: string) => void): void {
	if (!allowed(readConfig().askAlertSound)) return;
	const now = Date.now();
	if (now - lastAskAlert < MIN_INTERVAL_MS) return;
	lastAskAlert = now;
	const file = askAlertFile;
	if (!file) return;
	play(filePlayers(file), () => log(`[ask alert] could not play ${file} (missing file or no audio player)`));
}
