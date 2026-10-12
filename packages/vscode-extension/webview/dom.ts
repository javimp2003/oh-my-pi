/** DOM construction helpers shared by the chat and settings webviews. */

type Child = Node | string | null | undefined | false;

/** Element properties (`className`, `value`, `hidden`, `role`…) plus `data-*` values and raw attributes. */
export type Props<K extends keyof HTMLElementTagNameMap> = Partial<HTMLElementTagNameMap[K]> & {
	dataset?: Record<string, string>;
	attrs?: Record<string, string>;
};

/**
 * `h("div", { className: "row", dataset: { id } }, child, "text")`. Properties
 * whose value is `undefined` are skipped; `null`/`undefined`/`false` children
 * are dropped.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
	tag: K,
	props?: Props<K> | null,
	...children: Child[]
): HTMLElementTagNameMap[K] {
	const element = document.createElement(tag);
	if (props) {
		const { dataset, attrs, ...rest } = props;
		for (const [key, value] of Object.entries(rest)) {
			if (value !== undefined) (element as unknown as Record<string, unknown>)[key] = value;
		}
		if (dataset) Object.assign(element.dataset, dataset);
		if (attrs) for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
	}
	for (const child of children) {
		if (child !== null && child !== undefined && child !== false) element.append(child);
	}
	return element;
}

/** A `<button type="button">` wired to `onClick`. */
export function button(label: string, className: string, onClick: (event: MouseEvent) => void): HTMLButtonElement {
	const element = h("button", { type: "button", className, textContent: label });
	element.addEventListener("click", onClick);
	return element;
}
