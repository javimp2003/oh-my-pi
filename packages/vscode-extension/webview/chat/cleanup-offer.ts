/**
 * Card above the composer offering Clean up (`/shake`, the context ring's
 * button) once a session's context passes `CLEANUP_OFFER_PERCENT` of the
 * model's window: what it removes, what stays, and why it helps. Shown between
 * turns only, so it never interrupts a reply.
 */
import { CleanupOfferTracker } from "../../src/cleanup-offer";
import type { ChatRequest, SessionState, SessionStats } from "../../src/protocol";
import { button, h } from "../dom";
import { icon } from "../icons";
import { setTooltip } from "../tooltip";
import { formatTokens } from "./context-meter";

type Post = (request: ChatRequest) => void;

export class CleanupOffer {
	readonly element: HTMLElement;
	#tracker = new CleanupOfferTracker();
	#usage = h("span", { className: "cleanup-offer-usage" });
	#title = h("span", { className: "cleanup-offer-label" });
	/** Session the shown usage belongs to; `""` for a session without a file yet. */
	#session = "";
	#percent = 0;
	#known = false;
	#busy = false;
	#enabled = true;

	constructor(private readonly post: Post) {
		const close = button("×", "notice-close", () => this.#answer());
		setTooltip(close, "Ahora no");
		const run = button("Hacer Clean up", "cleanup-offer-run", () => {
			this.post({ type: "prompt", text: "/shake" });
			this.#answer();
		});
		this.element = h(
			"div",
			{ className: "cleanup-offer", role: "dialog", ariaLabel: "Sugerencia de Clean up", hidden: true },
			h(
				"div",
				{ className: "cleanup-offer-header" },
				h("span", { className: "cleanup-offer-icon" }, icon("eraser")),
				this.#title,
				this.#usage,
				close,
			),
			h(
				"div",
				{ className: "cleanup-offer-body" },
				h(
					"p",
					null,
					h("strong", null, "Qué hace. "),
					"Clean up (/shake) cambia los resultados antiguos de las herramientas (ficheros leídos, salidas de comandos, búsquedas) y los bloques grandes por una referencia breve, sin resumir nada. Tus mensajes y las respuestas de MarIA Code no cambian, y lo quitado queda guardado aparte: MarIA Code puede volver a leerlo si lo necesita.",
				),
				h(
					"p",
					null,
					h("strong", null, "Por qué conviene. "),
					"Cada petición al modelo reenvía todo el contexto. Con menos, las respuestas son más rápidas y baratas, el modelo se centra en lo que importa ahora y se aleja la compactación automática, que sí resume y pierde detalle. La primera petición después no podrá reutilizar la caché del proveedor para la parte limpiada.",
				),
			),
			h(
				"div",
				{ className: "cleanup-offer-actions" },
				button("Ahora no", "cleanup-offer-dismiss", () => this.#answer()),
				run,
			),
		);
	}

	setUsage(state: SessionState, stats: SessionStats | undefined): void {
		const usage = state.contextUsage ?? stats?.contextUsage;
		this.#known = usage !== undefined;
		this.#session = state.sessionFile ?? "";
		if (usage) {
			this.#percent = Math.min(100, Math.max(0, Math.round(usage.percent)));
			this.#title.textContent = `Contexto al ${this.#percent} %`;
			this.#usage.textContent = `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)} tokens`;
		}
		this.#render();
	}

	setBusy(busy: boolean): void {
		this.#busy = busy;
		this.#render();
	}

	setEnabled(enabled: boolean): void {
		this.#enabled = enabled;
		this.#render();
	}

	#answer(): void {
		this.#tracker.answer(this.#session);
		this.#render();
	}

	#render(): void {
		// The tracker sees every usage reading, also mid-turn, so a drop below the threshold re-arms it.
		const due = this.#known && this.#tracker.shouldOffer(this.#session, this.#percent);
		this.element.hidden = !due || this.#busy || !this.#enabled;
	}
}
