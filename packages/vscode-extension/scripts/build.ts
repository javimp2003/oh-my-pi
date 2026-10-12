/**
 * Bundles the extension host (Node, CommonJS, `vscode` external) and the
 * webviews (browser ESM + CSS) into `dist/`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.join(import.meta.dir, "..");
const dist = path.join(root, "dist");
const production = !process.argv.includes("--dev");

await fs.rm(dist, { recursive: true, force: true });

const host = await Bun.build({
	entrypoints: [path.join(root, "src/extension.ts")],
	outdir: dist,
	target: "node",
	format: "cjs",
	external: ["vscode"],
	minify: production,
	sourcemap: production ? "none" : "linked",
});
if (!host.success) throw new AggregateError(host.logs, "extension host build failed");

for (const view of ["chat", "settings"]) {
	const result = await Bun.build({
		entrypoints: [path.join(root, `webview/${view}/main.ts`)],
		outdir: path.join(dist, "webview"),
		naming: `${view}.js`,
		target: "browser",
		format: "esm",
		minify: production,
		sourcemap: production ? "none" : "inline",
	});
	if (!result.success) throw new AggregateError(result.logs, `${view} webview build failed`);
	await fs.copyFile(path.join(root, `webview/${view}/${view}.css`), path.join(dist, "webview", `${view}.css`));
}

console.log(`built ${path.relative(process.cwd(), dist)}`);
