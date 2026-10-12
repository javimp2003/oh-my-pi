/** Chat content helpers: image data URLs and clickable file references. */
import { h } from "../dom";

/** `data:` URL for a base64 image block. */
export function imageSrc(image: { data: string; mimeType: string }): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

/** A file reference parsed from `path`, `path:12`, `path:12-30`, or `path#L12`. */
export interface FileRef {
	path: string;
	line?: number;
}

export function parseFileRef(raw: string): FileRef {
	let text = raw.trim();
	if (text.startsWith("file://")) text = decodeURIComponent(text.slice("file://".length));
	const hash = /#L(\d+)(?:-L?\d+)?$/.exec(text);
	if (hash) return { path: text.slice(0, hash.index), line: Number(hash[1]) };
	const colon = /:(\d+)(?:[-:]\d+)?$/.exec(text);
	if (colon) return { path: text.slice(0, colon.index), line: Number(colon[1]) };
	return { path: text };
}

/** Clickable path; the transcript's delegated click handler turns `data-file` into `openFile`. */
export function fileLink(path: string, label = path): HTMLAnchorElement {
	return h("a", { className: "file-link", dataset: { file: path, tooltip: `Open ${path}` }, tabIndex: 0 }, label);
}

/** Image thumbnail in the transcript; the transcript's delegated click handler opens it in the lightbox. */
export function thumbnail(image: { data: string; mimeType: string }): HTMLImageElement {
	return h("img", {
		className: "thumb",
		src: imageSrc(image),
		alt: "Image",
		tabIndex: 0,
		dataset: { tooltip: "Preview image" },
	});
}
