import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

/** The HTML shell for a bundled webview (`dist/webview/<view>.js` + `.css`) under a strict CSP. */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, view: "chat" | "settings"): string {
	const asset = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", name));
	const nonce = randomBytes(16).toString("base64");
	const csp = [
		"default-src 'none'",
		`img-src ${webview.cspSource} https: data:`,
		`style-src ${webview.cspSource} 'unsafe-inline'`,
		`font-src ${webview.cspSource}`,
		`script-src 'nonce-${nonce}'`,
	].join("; ");
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${asset(`${view}.css`)}">
</head>
<body>
<div id="root"></div>
<script type="module" nonce="${nonce}" src="${asset(`${view}.js`)}"></script>
</body>
</html>`;
}
