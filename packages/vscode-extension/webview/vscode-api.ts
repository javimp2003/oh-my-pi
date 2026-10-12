/**
 * Typed wrapper around the VS Code webview API. `acquireVsCodeApi` may only be
 * called once per webview, so every module goes through `getVsCodeApi`.
 */

export interface VsCodeApi<Request, State> {
	postMessage(message: Request): void;
	getState(): State | undefined;
	setState(state: State): void;
}

declare function acquireVsCodeApi(): VsCodeApi<unknown, unknown>;

let api: VsCodeApi<unknown, unknown> | undefined;

export function getVsCodeApi<Request, State>(): VsCodeApi<Request, State> {
	api ??= acquireVsCodeApi();
	return api as VsCodeApi<Request, State>;
}
