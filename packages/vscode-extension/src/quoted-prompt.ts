/**
 * A reply to an excerpt of an earlier answer: the chat's "Reply" on selected
 * text sends the user's message wrapped with the excerpt (quoted-prompt.md), so
 * the model reads the message against it. The wrapper is plain prompt text in
 * the session; the webview and the session list parse it back to show the
 * user's own words. Shared by the extension host and the chat webview.
 *
 * The excerpt is quoted data: tags in it that would end its container or pass
 * for a harness notice (`</selected-excerpt>`, `<system-notice>` — omp treats
 * `<system-*>` tags in user messages as authoritative) are sent with `&lt;`,
 * and parsing restores them.
 */
import { compile } from "@oh-my-pi/pi-utils/prompt";
import template from "./quoted-prompt.md" with { type: "text" };

export interface QuotedPrompt {
	selection: string;
	message: string;
}

const TEMPLATE = template.replace(/\n+$/, "");
const render = compile(TEMPLATE);

/** The template's literal text before, between, and after its two placeholders. */
const [PREFIX, MIDDLE, SUFFIX] = (() => {
	const split = (text: string, placeholder: string): [string, string] => {
		const parts = text.split(placeholder);
		if (parts.length !== 2) throw new Error(`quoted-prompt.md must contain ${placeholder} exactly once`);
		return [parts[0]!, parts[1]!];
	};
	const [prefix, rest] = split(TEMPLATE, "{{selection}}");
	const [middle, suffix] = split(rest, "{{message}}");
	return [prefix, middle, suffix];
})();

/** Harness tags inside an excerpt, and their escaped form. */
const EXCERPT_TAG = /<(\/?)(selected-excerpt|system-)/gi;
const ESCAPED_EXCERPT_TAG = /&lt;(\/?)(selected-excerpt|system-)/gi;

/** The prompt sent for `message` replying to `selection`. */
export function quotedPrompt(selection: string, message: string): string {
	return render({ selection: selection.replace(EXCERPT_TAG, "&lt;$1$2"), message });
}

/** The excerpt and message of a prompt built by {@link quotedPrompt}; undefined for any other text. */
export function parseQuotedPrompt(text: string): QuotedPrompt | undefined {
	if (!text.startsWith(PREFIX) || !text.endsWith(SUFFIX)) return undefined;
	const end = text.length - SUFFIX.length;
	// The escaped excerpt cannot contain the separator, so its first occurrence ends the excerpt.
	const middle = text.indexOf(MIDDLE, PREFIX.length);
	if (middle < 0 || middle + MIDDLE.length > end) return undefined;
	return {
		selection: text.slice(PREFIX.length, middle).replace(ESCAPED_EXCERPT_TAG, "<$1$2"),
		message: text.slice(middle + MIDDLE.length, end),
	};
}
