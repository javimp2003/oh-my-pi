/**
 * Syntax highlighting for fenced code blocks: highlight.js core with the
 * languages agents usually emit. Output is escaped HTML with `hljs-*` spans,
 * colored by chat.css.
 */
import hljs from "highlight.js/lib/core";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import lua from "highlight.js/lib/languages/lua";
import makefile from "highlight.js/lib/languages/makefile";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import plaintext from "highlight.js/lib/languages/plaintext";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import scss from "highlight.js/lib/languages/scss";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

const LANGUAGES = {
	bash,
	c,
	cpp,
	csharp,
	css,
	diff,
	dockerfile,
	go,
	ini,
	java,
	javascript,
	json,
	kotlin,
	lua,
	makefile,
	markdown,
	php,
	plaintext,
	powershell,
	python,
	ruby,
	rust,
	scss,
	shell,
	sql,
	swift,
	typescript,
	xml,
	yaml,
};
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);
// Fence names highlight.js does not alias itself.
hljs.registerAliases(["toml"], { languageName: "ini" });
hljs.registerAliases(["jsonc", "json5"], { languageName: "json" });
hljs.registerAliases(["vue", "svelte"], { languageName: "xml" });

/** Highlighted HTML for `code`, or undefined when `language` is unknown (the caller escapes it as plain text). */
export function highlightCode(code: string, language: string): string | undefined {
	if (!language || !hljs.getLanguage(language)) return undefined;
	return hljs.highlight(code, { language, ignoreIllegals: true }).value;
}
