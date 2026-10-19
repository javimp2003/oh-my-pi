/**
 * Completion sound: a short system sound on the machine running omp (the
 * extension host's) when a turn finishes, so a task left running is noticed.
 * The OS's own player plays a sound file it already ships; nothing is decoded
 * or kept in memory here, and the player exits when the sound ends.
 */
import { spawn } from "node:child_process";
import * as vscode from "vscode";

export type CompletionSoundMode = "always" | "windowUnfocused" | "off";

/** Several sessions finishing together make one sound. */
const MIN_INTERVAL_MS = 1500;
let lastPlayed = 0;

/** Player commands to try in order; the next runs only when one is missing or fails. */
function players(): [string, string[]][] {
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

function play(queue: [string, string[]][]): void {
	const [next, ...rest] = queue;
	if (!next) return;
	const child = spawn(next[0], next[1], { stdio: "ignore", windowsHide: true });
	// `exit` may follow `error`; fall through to the next player once.
	let failed = false;
	const fail = () => {
		if (failed) return;
		failed = true;
		play(rest);
	};
	child.once("error", fail);
	child.once("exit", code => {
		if (code !== 0) fail();
	});
	child.unref();
}

/** Plays the sound for a finished turn, as `mode` allows. */
export function playCompletionSound(mode: CompletionSoundMode): void {
	if (mode === "off" || (mode === "windowUnfocused" && vscode.window.state.focused)) return;
	const now = Date.now();
	if (now - lastPlayed < MIN_INTERVAL_MS) return;
	lastPlayed = now;
	play(players());
}
