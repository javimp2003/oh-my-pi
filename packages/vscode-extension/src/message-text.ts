/** Extract text verbatim without including reasoning, images or tool arguments. */
export function contentText(
	content: string | ReadonlyArray<{ type: string; text?: string }>,
	separator = "\n",
): string {
	if (typeof content === "string") return content;
	return content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text)
		.join(separator);
}
