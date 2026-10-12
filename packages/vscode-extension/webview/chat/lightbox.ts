/**
 * Full-view image preview over the chat: the image at its natural size (fit to
 * the window when larger) on a dimmed backdrop. Escape, the close button, or a
 * click outside the image closes it and returns focus to what opened it.
 */
import { h, iconButton } from "../dom";

let open: { overlay: HTMLElement; restore: Element | null } | undefined;

export function openLightbox(src: string, alt = "Image preview"): void {
	closeLightbox();
	const image = h("img", { className: "lightbox-image", src, alt });
	const close = iconButton("close", "Close (Esc)", () => closeLightbox());
	close.classList.add("lightbox-close");
	const overlay = h(
		"div",
		{ className: "lightbox", role: "dialog", ariaModal: "true", ariaLabel: alt, tabIndex: -1 },
		image,
		close,
	);
	overlay.addEventListener("click", event => {
		if (event.target !== image) closeLightbox();
	});
	overlay.addEventListener("keydown", event => {
		if (event.key === "Escape") {
			event.preventDefault();
			event.stopPropagation();
			closeLightbox();
		} else if (event.key === "Tab") {
			// The close button is the only control: keep focus inside the dialog.
			event.preventDefault();
			close.focus();
		}
	});
	open = { overlay, restore: document.activeElement };
	document.body.append(overlay);
	close.focus();
}

export function closeLightbox(): void {
	if (!open) return;
	const { overlay, restore } = open;
	open = undefined;
	overlay.remove();
	if (restore instanceof HTMLElement && restore.isConnected) restore.focus();
}
