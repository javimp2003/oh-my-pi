/**
 * Leading glyph of a compact tool row (`display.compactToolOutput`). Every
 * entry is a default-emoji-presentation code point (no VS16 selector), so
 * terminals draw it two cells wide and tool names line up in one column.
 */
const COMPACT_TOOL_EMOJI: Record<string, string> = {
	read: "📄",
	grep: "🔍",
	glob: "📂",
	find: "🔎",
	ast_grep: "🧬",
	ast_edit: "🧩",
	web_search: "🌐",
	fetch: "🌐",
	browser: "🌐",
	bash: "💻",
	eval: "🧪",
	python: "🐍",
	edit: "📝",
	write: "💾",
	lsp: "🧭",
	task: "🤖",
	todo: "📋",
	ask: "💬",
	github: "🐙",
	debug: "🐞",
	memory: "🧠",
	resolve: "🎯",
	wait: "⏳",
	goal: "🏁",
	yield: "📤",
};

/** Emoji leading a compact row for `toolName`; unknown and extension tools share the wrench. */
export function compactToolEmoji(toolName: string): string {
	return COMPACT_TOOL_EMOJI[toolName] ?? "🔧";
}
