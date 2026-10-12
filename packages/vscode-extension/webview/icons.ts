/**
 * Lucide-style line icons built as SVG DOM nodes (no `innerHTML`, so the
 * webview CSP stays strict). Size them with CSS `width`/`height`.
 */

export type IconName =
	| "plus"
	| "history"
	| "settings"
	| "arrowUp"
	| "stop"
	| "chevronDown"
	| "chevronRight"
	| "back"
	| "copy"
	| "check"
	| "search"
	| "terminal"
	| "file"
	| "pencil"
	| "globe"
	| "bot"
	| "wrench"
	| "brain"
	| "plan"
	| "shrink"
	| "eraser"
	| "handoff"
	| "python";

const SVG_NS = "http://www.w3.org/2000/svg";

const PATHS: Record<IconName, string> = {
	plus: "M5 12h14M12 5v14",
	history: "M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8M3 3v5h5M12 7v5l4 2",
	settings:
		"M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0z",
	arrowUp: "M12 19V5M5 12l7-7 7 7",
	stop: "M8 6h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z",
	chevronDown: "m6 9 6 6 6-6",
	chevronRight: "m9 18 6-6-6-6",
	back: "M19 12H5M12 19l-7-7 7-7",
	copy: "M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2zM4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2",
	check: "M20 6 9 17l-5-5",
	search: "M19 11a8 8 0 1 1-16 0 8 8 0 0 1 16 0zM21 21l-4.3-4.3",
	terminal: "m4 17 6-6-6-6M12 19h8",
	file: "M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7zM14 2v4a2 2 0 0 0 2 2h4",
	pencil:
		"M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5zM15 5l4 4",
	globe: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0zM12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20M2 12h20",
	bot: "M12 8V4H8M6 8h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2zM2 14h2M20 14h2M15 13v2M9 13v2",
	wrench:
		"M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z",
	brain: "M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18zM12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18zM15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4M17.599 6.5a3 3 0 0 0 .399-1.375M6.003 5.125A3 3 0 0 0 6.401 6.5M3.477 10.896a4 4 0 0 1 .585-.396M19.938 10.5a4 4 0 0 1 .585.396M6 18a4 4 0 0 1-1.967-.516M19.967 17.484A4 4 0 0 1 18 18",
	plan: "M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01",
	shrink:
		"m15 15 6 6m-6-6v4.8m0-4.8h4.8M9 19.8V15m0 0H4.2M9 15l-6 6M15 4.2V9m0 0h4.8M15 9l6-6M9 4.2V9m0 0H4.2M9 9 3 3",
	eraser: "m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7M5 11l9 9",
	handoff: "m16 3 4 4-4 4M20 7H4M8 21l-4-4 4-4M4 17h16",
	// The Python logo's two interlocking snakes, as an outline.
	python:
		"M12 2c-3 0-4 1.3-4 3v2h4v1H5c-2 0-3 1.5-3 4s1 4 3 4h2v-2.5c0-1.9 1.6-3.5 3.5-3.5h3c1.4 0 2.5-1.1 2.5-2.5V5c0-1.7-1-3-4-3zM12 22c3 0 4-1.3 4-3v-2h-4v-1h7c2 0 3-1.5 3-4s-1-4-3-4h-2v2.5c0 1.9-1.6 3.5-3.5 3.5h-3C9.1 14 8 15.1 8 16.5V19c0 1.7 1 3 4 3zM10 4.5h.01M14 19.5h.01",
};

/** Icons drawn as filled shapes instead of strokes. */
const FILLED: Partial<Record<IconName, true>> = { stop: true };

export function icon(name: IconName): SVGSVGElement {
	const svg = document.createElementNS(SVG_NS, "svg");
	const filled = FILLED[name] === true;
	const attrs: Record<string, string> = {
		class: `icon icon-${name}`,
		width: "16",
		height: "16",
		viewBox: "0 0 24 24",
		fill: filled ? "currentColor" : "none",
		stroke: filled ? "none" : "currentColor",
		"stroke-width": "2",
		"stroke-linecap": "round",
		"stroke-linejoin": "round",
		"aria-hidden": "true",
	};
	for (const [key, value] of Object.entries(attrs)) svg.setAttribute(key, value);
	const path = document.createElementNS(SVG_NS, "path");
	path.setAttribute("d", PATHS[name]);
	svg.append(path);
	return svg;
}
