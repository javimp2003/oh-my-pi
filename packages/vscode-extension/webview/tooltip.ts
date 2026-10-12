/**
 * Hover tooltips for the chat webview. Native `title` tooltips are drawn by
 * Chromium/Electron with a fixed delay of about a second that pages cannot
 * shorten, only appear once the pointer rests, and are dropped when the chat
 * re-renders or rewrites the attribute (state refreshes rewrite toggle and ring
 * titles). Elements opt in with `data-tooltip` (`setTooltip`); one delegated
 * listener shows a themed bubble after a short delay, instantly while moving
 * between tooltipped controls, and keeps it across re-renders.
 */

const SHOW_DELAY_MS = 350;
/** Moving to another target within this window after a tooltip hid shows the next one at once. */
const WARM_MS = 300;
const GAP_PX = 6;
const EDGE_PX = 6;

/** Set (or clear, with `undefined`/empty) the hover text of `element`. */
export function setTooltip(element: HTMLElement, text: string | undefined): void {
	if (text) element.dataset.tooltip = text;
	else delete element.dataset.tooltip;
}

/** Install the delegated tooltip on `document`; call once per webview. */
export function installTooltips(): void {
	const bubble = document.createElement("div");
	bubble.className = "tooltip";
	bubble.setAttribute("role", "tooltip");
	bubble.hidden = true;
	document.body.append(bubble);

	let target: HTMLElement | undefined;
	let timer = 0;
	let hiddenAt = 0;

	const hide = () => {
		window.clearTimeout(timer);
		timer = 0;
		if (!bubble.hidden) hiddenAt = Date.now();
		bubble.hidden = true;
		target = undefined;
	};

	const show = (element: HTMLElement) => {
		const text = element.dataset.tooltip;
		// An open menu or popover already covers what the control's tooltip would say.
		if (!text || !element.isConnected || element.ariaExpanded === "true") return hide();
		bubble.textContent = text;
		bubble.hidden = false;
		const anchor = element.getBoundingClientRect();
		const box = bubble.getBoundingClientRect();
		// Above the control (the composer sits at the bottom), below when there is no room.
		const above = anchor.top - GAP_PX - box.height;
		const top = above >= EDGE_PX ? above : anchor.bottom + GAP_PX;
		const centered = anchor.left + anchor.width / 2 - box.width / 2;
		const left = Math.min(Math.max(centered, EDGE_PX), window.innerWidth - box.width - EDGE_PX);
		bubble.style.top = `${Math.round(top)}px`;
		bubble.style.left = `${Math.round(Math.max(left, EDGE_PX))}px`;
	};

	document.addEventListener("pointerover", event => {
		const element = (event.target as Element | null)?.closest?.<HTMLElement>("[data-tooltip]") ?? undefined;
		if (element === target) return;
		const warm = !bubble.hidden || Date.now() - hiddenAt < WARM_MS;
		hide();
		if (!element) return;
		target = element;
		if (warm) show(element);
		else timer = window.setTimeout(() => show(element), SHOW_DELAY_MS);
	});
	document.addEventListener("pointerout", event => {
		if (!target) return;
		const next = event.relatedTarget as Node | null;
		if (!next || !target.contains(next)) hide();
	});
	// Any interaction or movement of the page makes the bubble stale.
	document.addEventListener("pointerdown", hide, true);
	document.addEventListener("keydown", hide, true);
	document.addEventListener("scroll", hide, true);
	window.addEventListener("blur", hide);
}
