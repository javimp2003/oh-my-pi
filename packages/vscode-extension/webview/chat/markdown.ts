/**
 * Markdown → HTML for assistant text. Raw HTML in the source is escaped, links
 * carry their target in `data-href` (never `href`) so the delegated click
 * handler decides between `openExternal` and `openFile`, and fenced code gets a
 * copy button.
 */
import { Marked, type Tokens } from "marked";
import { highlightCode } from "./highlight";

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export function escapeHtml(text: string): string {
	return text.replace(/[&<>"']/g, ch => ESCAPES[ch] ?? ch);
}

const SOURCE_EXTENSIONS =
	"ts|tsx|js|jsx|mjs|cjs|json|jsonc|md|mdx|py|rs|go|java|kt|c|h|cc|cpp|hpp|cs|rb|php|swift|css|scss|less|html|vue|svelte|yml|yaml|toml|ini|sh|bash|zsh|txt|sql|xml|lock|proto|gradle|lua|zig|dart|ex|exs";
const FILE_WITH_KNOWN_EXT = new RegExp(`^[\\w@~./-]+\\.(?:${SOURCE_EXTENSIONS})(?::\\d+(?:-\\d+)?)?$`);
const PATH_WITH_SLASH = /^(?:~|\.{1,2})?\/?[\w@.-]+(?:\/[\w@.-]+)+\.\w{1,10}(?::\d+(?:-\d+)?)?$/;

/** Heuristic for inline code that names a file (`src/app.ts`, `README.md:12`). */
export function looksLikeFilePath(text: string): boolean {
	if (text.length > 200 || /\s/.test(text) || /^[a-z]+:\/\//i.test(text)) return false;
	return FILE_WITH_KNOWN_EXT.test(text) || PATH_WITH_SLASH.test(text);
}

function codeBlock(text: string, lang: string | undefined): string {
	const language = (lang ?? "").trim().split(/\s+/)[0] ?? "";
	const source = text.replace(/\n$/, "");
	const code = highlightCode(source, language.toLowerCase()) ?? escapeHtml(source);
	return (
		`<div class="code-block"><div class="code-header"><span class="code-lang">${escapeHtml(language)}</span>` +
		`<button type="button" class="copy-btn" data-tooltip="Copy" aria-label="Copy"></button></div>` +
		`<pre><code class="hljs">${code}</code></pre></div>`
	);
}

const marked = new Marked({
	gfm: true,
	breaks: false,
	renderer: {
		html({ text }: Tokens.HTML | Tokens.Tag): string {
			return escapeHtml(text);
		},
		code({ text, lang }: Tokens.Code): string {
			return codeBlock(text, lang);
		},
		codespan({ text }: Tokens.Codespan): string {
			if (looksLikeFilePath(text)) {
				return `<code class="file-link" data-file="${escapeHtml(text)}" tabindex="0">${escapeHtml(text)}</code>`;
			}
			return `<code>${escapeHtml(text)}</code>`;
		},
		link({ href, title, tokens }: Tokens.Link): string {
			const label = this.parser.parseInline(tokens);
			return `<a data-href="${escapeHtml(href)}" tabindex="0" data-tooltip="${escapeHtml(title || href)}">${label}</a>`;
		},
		image({ href, text }: Tokens.Image): string {
			return `<a data-href="${escapeHtml(href)}" tabindex="0" data-tooltip="${escapeHtml(href)}">${escapeHtml(text || href)}</a>`;
		},
	},
});

export function renderMarkdown(source: string): string {
	return marked.parse(source, { async: false });
}
