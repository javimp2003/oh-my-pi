import { getComposerStyle } from "../components/composer/registry";
import { Spacer } from "../components/spacer";
import type { StatusLineComponent } from "../status-line/component";
import type { StatusLineSession } from "../status-line/host";
import { createStartupStatusLine, type StatusLineStartupData } from "../status-line/startup";
import { isInsideTerminalMultiplexer } from "../terminal-multiplexer";
import { ProcessTerminal, type Terminal } from "../terminal";
import {
	type Component,
	Container,
	type ResizeScrollbackMode,
	type TerminalFramePlan,
	type TerminalFrameProvider,
	TUI,
	type TUIOptions,
	type ViewportSize,
} from "../tui";
import { Ellipsis, truncateToWidth, wrapLiteralLine } from "../utils";
import type { NativeChild, NativeSurface, NativeSurfaceProvider } from "../native/node";
import { sameItems } from "../native/memo";
import { postmortem } from "@oh-my-pi/pi-utils";
import { CustomEditor } from "./custom-editor";
import type { WordCompletionMethod } from "./word-completion";
import { type AnimationFrame, TranscriptContainer } from "../chrome/transcript-container";
import { WelcomeComponent } from "./welcome";
import { ensureThemeSync, getEditorTheme, theme } from "../theme/theme";
import { orderSelection, paintSelection, type SelectionPoint, selectedText } from "./text-selection";

const DOUBLE_INTERRUPT_MS = 500;
/** Rows a page scroll keeps from the previous window, so reading stays continuous. */
const PAGE_SCROLL_OVERLAP = 2;
/** Pace of the one-row scroll while a selection drag rests on the window's edge. */
const SELECTION_SCROLL_INTERVAL_MS = 60;

/** Live settings that affect the composer before and after session adoption. */
export interface ComposerPreferences {
	readonly quiet: boolean;
	readonly composerShape: string;
	readonly showHardwareCursor: boolean;
	readonly maxInlineImages: number;
	readonly resizeScrollback: ResizeScrollbackMode;
	readonly imeSafeCursor: boolean;
	readonly autocompleteMaxVisible: number;
	readonly spellingTypoDetection: boolean;
	readonly spellingAutocomplete: WordCompletionMethod;
	readonly spellingAutocorrect: boolean;
	/**
	 * Keep the editor and status chrome fixed on the bottom rows: the
	 * transcript renders into its own scrollable window above them and never
	 * retires to native scrollback while on (see {@link Composer.scrollTranscript}).
	 */
	readonly pinnedInput: boolean;
}

/** Settings-schema-compatible defaults used when constructing a dependency-free composer. */
export const COMPOSER_DEFAULTS: ComposerPreferences = {
	quiet: false,
	composerShape: "band",
	showHardwareCursor: true,
	maxInlineImages: 8,
	resizeScrollback: "rebuild",
	imeSafeCursor: false,
	autocompleteMaxVisible: 10,
	spellingTypoDetection: true,
	spellingAutocomplete: "auto",
	spellingAutocorrect: false,
	pinnedInput: false,
};

/** Welcome data that can be supplied initially or patched as startup resolves it. */
export interface ComposerWelcomeUpdate {
	readonly version?: string;
}

/**
 * Status-bar inputs persisted by the last session. The first frame renders
 * them through a startup {@link StatusLineComponent} at the live width until
 * the session-aware status line attaches.
 */
export interface ComposerStatusCache {
	/** ANSI wrapper of the editor border when persisted (session accent or thinking color). */
	readonly borderColor?: {
		readonly prefix: string;
		readonly suffix: string;
	};
	readonly statusLine: StatusLineStartupData;
}

/** Optional dependencies and initial state for a standalone composer. */
export interface ComposerOptions {
	readonly terminal?: Terminal;
	/** Extra TUI construction options (render scheduler injection for tests and `omp render`). */
	readonly tuiOptions?: TUIOptions;
	readonly preferences?: Partial<ComposerPreferences>;
	readonly welcome?: ComposerWelcomeUpdate;
	readonly status?: ComposerStatusCache;
	readonly exit?: (code: number) => void;
	readonly now?: () => number;
}

/** How {@link Composer.setRuntimeChildren} bills below-transcript roots against transcript retirement. */
export interface RuntimeChildrenOptions {
	/**
	 * Below-transcript roots whose growth is momentary (inline dialogs, a tall
	 * multi-line editor). They are billed at their smallest height so expansion
	 * clips the live tail instead of retiring rows a later shrink could not
	 * reclaim (#11007). Every other root is billed at its current height, so
	 * settled rows it displaces retire to native scrollback. Decision panels
	 * declaring `retireDisplacedTranscript` opt out of this floor even when
	 * mounted as a child of a transient editor container.
	 */
	readonly transient?: readonly Component[];
	/**
	 * Dock order on a TSP terminal (no status strip; the composer carries its
	 * facts): the native dock stacks HUD pills, the working row and queued messages over
	 * the composer in its own order, and may add describe-only roots. Defaults
	 * to the roots below the transcript in render order.
	 */
	readonly nativeDock?: readonly Component[];
}

/** Controls the first terminal paint for a composer that does not already own the terminal. */
export interface ComposerStartOptions {
	readonly clearScrollback?: boolean;
	readonly playWelcomeIntro?: boolean;
	/**
	 * Paint without owning stdin: the tty keeps cooked-mode echo/editing so
	 * typing stays visible while startup module loading blocks the event loop.
	 * {@link Composer.enableInput} later switches to raw input and replays the
	 * kernel-buffered keystrokes into the editor.
	 */
	readonly deferInput?: boolean;
}

/**
 * Mount slot below the editor: the startup status line, then the session-aware
 * one. ANSI only: a TSP terminal has no status strip, the composer carries the
 * status line's facts ({@link StatusLineComponent.describeComposerFacts}).
 */
class StatusHost implements Component {
	#component: Component | undefined;

	setComponent(component: Component): void {
		this.#component = component;
	}

	render(width: number): readonly string[] {
		return this.#component?.render(width) ?? [];
	}
}

/** One click target's row span within the mutable viewport (half-open `[start, end)`). */
export interface ViewportClickSpan {
	start: number;
	end: number;
	/** Candidate subagent ids for a span-local row. */
	candidates: (local: number) => string[];
}

/**
 * Row-level click target: maps rendered rows to subagent ids. Implemented by
 * the subagent HUD, whose rows are fixed 1:1 with visible sessions.
 */
export interface ViewportClickRowTarget {
	getClickAgentAtRow(row: number): string | undefined;
}

/**
 * Candidates under a mutable-viewport line: the first span containing it.
 * Pure seam for tests; the caller intersects with the live registry, which
 * decides focusability and recency.
 */
export function routeViewportClick(spans: readonly ViewportClickSpan[], index: number): string[] {
	if (!Number.isInteger(index) || index < 0) return [];
	for (const span of spans) {
		if (index < span.start || index >= span.end) continue;
		return span.candidates(index - span.start);
	}
	return [];
}

/**
 * Reserved click-candidate id for the pinned HUD expander row. Checked before
 * any registry lookup: its `@…:…` charset cannot collide with generated agent
 * ids (word names, numeric and `-N` suffixes, dotted nesting).
 */
export const PINNED_HUD_TOGGLE_ID = "@omp:toggle-pinned-hud";

/**
 * Nested background opens inside a hovered row. The band wraps the line, so a
 * surviving nested open would paint over it for every cell it covers; the
 * matching closes stay and become band resumes via bgFill.
 */
const NESTED_BG_OPEN_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[(?:4[0-7]|10[0-7]|48;[0-9;]*)m`, "g");

/**
 * Candidate resolver for a row-level click target, if the component is one.
 * Shared by root and nested-child hit-testing so both stay in lockstep.
 */
function rowTargetCandidates(target: Component): ((local: number) => string[]) | undefined {
	const rowTarget = target as Partial<ViewportClickRowTarget>;
	if (typeof rowTarget.getClickAgentAtRow !== "function") return undefined;
	return (local: number) => {
		const id = rowTarget.getClickAgentAtRow?.(local);
		return id === undefined ? [] : [id];
	};
}

/**
 * Canonical interactive composer, usable before session/settings exist and updatable in place.
 * It owns the terminal, welcome header, and editor; InteractiveMode later supplies authoritative
 * data and mounts the session-aware runtime children without replacing the visible header.
 */
export class Composer implements TerminalFrameProvider, NativeSurfaceProvider {
	readonly ui: TUI;
	#editor: CustomEditor;
	readonly #header = new Container();
	readonly #bootstrapInputGap = new Spacer(1);
	readonly #statusHost = new StatusHost();
	readonly #exit: (code: number) => void;
	readonly #now: () => number;
	#preferences: ComposerPreferences;
	#welcome: WelcomeComponent | undefined;
	#version = "";
	#headerBefore: readonly Component[] = [];
	#headerAfter: readonly Component[] = [];
	#runtimeChildren: readonly Component[] = [];
	#nativeDock: readonly Component[] | undefined;
	/** Cache-driven status line shown until {@link setStatusComponent} mounts the session's. */
	#startupStatus: StatusLineComponent | undefined;
	#runtimeMounted = false;
	// Composer-owned history id space. Transcript batch ids restart across
	// container clears/swaps; the composer translates them into one monotonic
	// sequence the terminal's accepted-id watermark can trust.
	#nextHistoryId = 1;
	#offeredHistory:
		| {
				id: number;
				rows: readonly string[];
				kind: "append" | "replay";
				source:
					| "header"
					| {
							transcript: TranscriptContainer;
							transcriptId?: number;
							header: "none" | "replay";
							/** Recomposed header rows to accept as the new retired-header bytes. */
							headerRows?: readonly string[];
					  };
		  }
		| undefined;
	#historyReplayRequested = false;
	#headerReplayPending = false;
	#historyFlush = false;
	// The welcome header retires to terminal history exactly once, after the
	// intro settles; until then it renders as mutable viewport chrome.
	#headerRetired = false;
	// Exact hard rows accepted into native history. Transient resize-alt
	// paints reflow these rows to match the terminal's own rewrap of history
	// it still holds; a settled replay owns every byte it emits, so it
	// recomposes the header at the replay width and refreshes these rows.
	#retiredHeaderRows: readonly string[] | undefined;
	/** Click spans of the last `renderFrame` viewport, in viewport coordinates. */
	#lastClickSpans: ViewportClickSpan[] = [];
	/** Click-candidate id under the pointer, painted with the hover band. Id-anchored so it follows streaming rows. */
	#hoveredClickId: string | undefined;
	// Hard-row prefix currently above the native viewport. The first resize
	// frame may pull part of it down before the normal buffer is borrowed.
	#retiredHeaderStart = 0;
	#resizeRetiredHeaderStart: number | undefined;
	#lastNormalRows = 0;
	// Roots from `RuntimeChildrenOptions.transient`, and the smallest height
	// they have rendered at since mount. Retirement bills transient roots at
	// this floor, never their peak, so a transient dialog or tall editor that later
	// shrinks never leaves committed transcript rows the live viewport cannot
	// reclaim (#11007). Persistent roots (loader, todo/subagent HUDs) bill at
	// their current height: they stay up for a whole turn, and billing them at
	// an idle floor hid the settled rows they displaced until the turn ended.
	// The floor is terminal-height independent — editor and dialog heights do
	// not scale with rows — so it is retained across resizes rather than
	// rediscovered from whatever chrome is expanded when the height changes.
	#transientChrome: ReadonlySet<Component> = new Set();
	#transientChromeFloor: number | undefined;
	#anchorAfterInlineRetirement = false;
	/** Rows the chrome below each below-transcript root took in the last frame (see {@link rowsBelow}). */
	#rowsBelow = new Map<Component, number>();
	#lastInterruptAt = 0;
	/** Last described surface; its arrays are reused while their children are unchanged. */
	#nativeSurface: NativeSurface = { main: [], dock: [] };
	#started = false;
	#stopped = false;
	#transferred = false;
	/**
	 * Pinned-input window top row while the user reads older transcript rows;
	 * `undefined` follows the newest rows. Anchored to the top of the content,
	 * so rows streaming in below never move what the user is reading.
	 */
	#scrollAnchor: number | undefined;
	/** Rows requested by scroll gestures since the last frame (negative = up). */
	#scrollDelta = 0;
	/** Transcript window height of the last pinned frame: the page size. */
	#scrollCapacity = 0;
	/**
	 * Mouse text selection in the pinned layout (`tui.mouseSelection`).
	 * `region` is where the press landed: the scrolling transcript window
	 * (points in content rows, so the window can scroll under a drag) or the
	 * chrome below it (points in chrome rows). `anchor` resolves on the first
	 * frame after the press, which reports the window's content offset; `head`
	 * keeps the pointer's viewport row and resolves every frame.
	 */
	#selection:
		| {
				region: "transcript" | "chrome";
				press: SelectionPoint;
				anchor: SelectionPoint | undefined;
				head: SelectionPoint;
				moved: boolean;
				/** The window followed the newest rows when the press landed; release resumes that. */
				following: boolean;
				/** Last painted ordered range and the rows it indexes, for the copy on release. */
				range?: { start: SelectionPoint; end: SelectionPoint; lines: readonly string[] };
		  }
		| undefined;
	/** Repeats a one-row scroll while a selection drag rests against the window's top or bottom edge. */
	#selectionScrollTimer: NodeJS.Timeout | undefined;
	#selectionScrollDirection: -1 | 0 | 1 = 0;

	constructor(options: ComposerOptions = {}) {
		ensureThemeSync();
		// Host-owned hard exit: route through postmortem so a double-Ctrl-C during
		// an open extension-load guard window exits cleanly instead of throwing
		// ExtensionExitError through the guarded process.exit (#11789).
		this.#exit = options.exit ?? (code => postmortem.exitProcess(code));
		this.#now = options.now ?? Date.now;
		this.#preferences = { ...COMPOSER_DEFAULTS, ...options.preferences };
		this.#applyWelcomeUpdate(options.welcome ?? {});

		this.ui = new TUI(
			options.terminal ?? new ProcessTerminal(),
			this.#preferences.showHardwareCursor,
			options.tuiOptions,
		);
		this.ui.setFrameProvider(this);
		this.ui.setMaxInlineImages(this.#preferences.maxInlineImages);
		this.ui.setResizeScrollback(this.#preferences.resizeScrollback);

		this.#editor = new CustomEditor(getEditorTheme());
		this.editor.disableSubmit = true;
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.editor.setImeSafeCursorLayout(this.#preferences.imeSafeCursor);
		this.editor.setAutocompleteMaxVisible(this.#preferences.autocompleteMaxVisible);
		this.editor.setSpellingFeatures({
			typoDetection: this.#preferences.spellingTypoDetection,
			autocomplete: this.#preferences.spellingAutocomplete,
			autocorrect: this.#preferences.spellingAutocorrect,
		});
		try {
			this.editor.setBorderStyle(this.#preferences.composerShape);
		} catch {
			// Extension-defined styles arrive with the session; InteractiveMode reapplies them.
		}
		if (options.status) {
			const { borderColor, statusLine } = options.status;
			if (borderColor) this.editor.borderColor = text => `${borderColor.prefix}${text}${borderColor.suffix}`;
			this.#startupStatus = createStartupStatusLine(statusLine);
			this.#statusHost.setComponent(this.#startupStatus);
			this.#startupStatus.attachToEditor(this.editor, getComposerStyle(this.#preferences.composerShape));
		}
		// Emergency controls stay active until InteractiveMode installs configured bindings.
		// They deliberately mirror the interactive editor's contract so a stalled startup
		// never behaves differently from a healthy one: Ctrl+C clears the draft and a second
		// press exits 130 — the unconditional abort, draft or not; Ctrl+D exits 0 on an
		// empty draft and otherwise forward-deletes (see CustomEditor's app.exit handling),
		// so typing while the session loads cannot be lost to a mistyped delete.
		this.editor.setActionKeys("app.clear", ["ctrl+c"]);
		this.editor.setActionKeys("app.exit", ["ctrl+d"]);
		this.editor.onClear = () => this.#handleInterrupt();
		this.editor.onExit = () => this.#requestExit(0);
		this.editor.setShimmerRepaintHandler(() => this.ui.requestComponentRender(this.editor));

		if (!this.#preferences.quiet) this.#ensureWelcome();
		this.#rebuildHeader();
		this.ui.addChild(this.#header);
		this.ui.addChild(this.#bootstrapInputGap);
		this.ui.addChild(this.editor);
		this.ui.addChild(this.#statusHost);
		this.ui.setFocus(this.editor);
	}
	/**
	 * Rows the below-transcript chrome under `root` (editor, status line, …)
	 * took in the last frame, so a root that grows upward can cap itself to
	 * the screen rows left above them; `undefined` before `root` was laid out.
	 */
	rowsBelow(root: Component): number | undefined {
		return this.#rowsBelow.get(root);
	}

	/**
	 * Keep the input on the bottom row while the live rows cannot fill the
	 * screen, as after an inline decision panel closes. A tall block that just
	 * left the chrome above the editor (a command report) may have scrolled
	 * rows into native history that cannot be pulled back; without the pin the
	 * editor would jump up to where the shorter frame now ends. The pin lifts
	 * once live rows fill the screen again.
	 */
	pinInputToBottom(): void {
		this.#anchorAfterInlineRetirement = true;
	}

	/** Compose the bounded mutable viewport and the next ordered history append. */
	renderFrame(viewport: ViewportSize): TerminalFramePlan {
		if (!this.#started || this.#stopped) return { viewport: [] };
		const width = Math.max(1, viewport.columns);
		const rows = Math.max(0, viewport.rows);
		if (this.#resizeRetiredHeaderStart !== undefined) {
			this.#retiredHeaderStart = this.#resizeRetiredHeaderStart;
			this.#resizeRetiredHeaderStart = undefined;
		}
		this.#lastNormalRows = rows;
		const roots = this.#runtimeMounted
			? [...this.#runtimeChildren, this.#statusHost]
			: [this.#header, this.#bootstrapInputGap, this.editor, this.#statusHost];
		const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
		if (transcriptIndex < 0) {
			this.#lastClickSpans = [];
			return { viewport: this.#renderRoots(roots, width).slice(-rows) };
		}
		const transcript = roots[transcriptIndex] as TranscriptContainer;
		// A shutdown flush leaves the pinned layout: the transcript retires to
		// native scrollback so it outlives the session like inline output does.
		if (this.#preferences.pinnedInput && !this.#historyFlush) {
			return this.#renderPinnedFrame(roots, transcriptIndex, width, rows);
		}
		const preRoots = this.#renderRoots(roots.slice(0, transcriptIndex), width);
		const afterRoots = roots.slice(transcriptIndex + 1);
		const after: string[] = [];
		const afterSpans: ViewportClickSpan[] = [];
		let transientRows = 0;
		let displacingRows = 0;
		let decisionPanelOpen = false;
		const ends: { root: Component; end: number }[] = [];
		for (const root of afterRoots) {
			const chrome: Component = root;
			const start = after.length;
			this.#renderBelowRoot(root, width, after, afterSpans);
			ends.push({ root, end: after.length });
			if (this.#transientChrome.has(root)) transientRows += after.length - start;
			if (
				chrome.retireDisplacedTranscript ||
				(root instanceof Container && root.children.some(child => child.retireDisplacedTranscript))
			) {
				if (this.#transientChrome.has(root)) displacingRows += after.length - start;
				decisionPanelOpen = true;
			}
		}
		this.#rowsBelow = new Map(ends.map(({ root, end }) => [root, after.length - end]));
		// Offer history under capacity pressure only: blocks stay live (and keep
		// reflowing to the current width) while the screen has room. A batch
		// leaves the mutable viewport in the same frame it is appended, so its
		// rows are never painted twice.
		//
		// Retirement bills ordinary transient roots at their floor, not their
		// peak: a confirmation dialog or a tall multi-line editor clips the live tail for
		// its lifetime, but must not permanently commit transcript rows to native
		// history — otherwise a later shrink cannot refill the freed rows and the
		// editor drifts up above a band of blank rows (#11007).
		this.#transientChromeFloor = Math.min(this.#transientChromeFloor ?? transientRows, transientRows);
		// An ask panel remains open while the user reads the preceding response.
		// Its displaced settled rows must be reachable in scrollback now, rather
		// than clipped until the panel closes. Ordinary drafts retain their floor.
		const belowFloor = after.length - transientRows + Math.max(this.#transientChromeFloor, displacingRows);
		const now = performance.now();
		const frame: AnimationFrame = { now, tick: Math.floor(now / 80) };
		// Retirement measures the same live blocks the viewport lays out below;
		// one open frame renders each of them once for both.
		transcript.beginFrame(frame);
		const history = this.#offerHistory(transcript, width, rows, preRoots.length + belowFloor);
		if (decisionPanelOpen && history !== undefined) this.#anchorAfterInlineRetirement = true;
		const headerVisible = !this.#headerRetired && this.#offeredHistory?.source !== "header";
		const headerRows = headerVisible ? this.#header.render(width) : [];
		const before = [...headerRows, ...preRoots];
		// The live tail is laid out against the same baseline retirement is
		// billed against, so its compaction allocator (one row per block, no
		// inter-block blanks) engages only when a block genuinely cannot retire.
		// Rows the transient chrome peak displaces are clipped from the top by
		// the `drop` slice below, which is what scrollback would have done.
		const active = transcript.renderViewport(width, Math.max(0, rows - before.length - belowFloor), frame);
		const activeSpans: ViewportClickSpan[] = [];
		for (const span of transcript.getLastViewportSpans()) {
			const ids = (span.component as Partial<{ getClickFocusAgentIds(): string[] }>).getClickFocusAgentIds?.();
			if (!ids || ids.length === 0) continue;
			activeSpans.push({ start: span.start, end: span.end, candidates: () => ids });
		}
		const drop = Math.max(0, before.length + active.length + after.length - rows);
		const mutable = [...before, ...active, ...after].slice(drop);
		// Once live rows fill the screen again, the retired gap is gone.
		if (!decisionPanelOpen && mutable.length >= rows) this.#anchorAfterInlineRetirement = false;
		// Rows retired during a decision panel cannot be pulled back from native
		// history when it closes. Keep the input pinned to the bottom without
		// replaying those rows (which would duplicate them) or clearing history.
		const topPadding = this.#anchorAfterInlineRetirement ? Math.max(0, rows - mutable.length) : 0;
		if (topPadding > 0) mutable.unshift(...Array<string>(topPadding).fill(""));
		const viewportLength = mutable.length;
		const spans: ViewportClickSpan[] = [];
		const shift = (span: ViewportClickSpan, base: number): void => {
			const start = span.start + base;
			const end = Math.min(span.end + base, viewportLength);
			const clamped = Math.max(0, start);
			if (end > clamped) {
				// A clipped head must offset the callback: without the skew the
				// first visible row would hit-test as span-local row 0.
				const skew = clamped - start;
				spans.push({ start: clamped, end, candidates: (local: number) => span.candidates(local + skew) });
			}
		};
		for (const span of activeSpans) shift(span, topPadding + before.length - drop);
		for (const span of afterSpans) shift(span, topPadding + before.length + active.length - drop);
		this.#lastClickSpans = spans;
		if (history !== undefined && this.#offeredHistory?.source === "header") {
			const visibleHeaderRows = Math.max(0, rows - (mutable.length + drop));
			this.#retiredHeaderStart = Math.max(0, history.rows.length - visibleHeaderRows);
		}
		return { history, viewport: this.#paintHoverBand(mutable, spans) };
	}

	/**
	 * Pinned-input frame: the chrome below the transcript (editor, status,
	 * HUDs) owns the bottom rows and the header plus transcript scroll in the
	 * window above, so the viewport always spans the whole screen and nothing
	 * retires to native history. Content shorter than the window is top-aligned
	 * and the gap above the chrome stays blank.
	 */
	#renderPinnedFrame(
		roots: readonly Component[],
		transcriptIndex: number,
		width: number,
		rows: number,
	): TerminalFramePlan {
		const transcript = roots[transcriptIndex] as TranscriptContainer;
		const after: string[] = [];
		const afterSpans: ViewportClickSpan[] = [];
		const ends: { root: Component; end: number }[] = [];
		for (const root of roots.slice(transcriptIndex + 1)) {
			this.#renderBelowRoot(root, width, after, afterSpans);
			ends.push({ root, end: after.length });
		}
		this.#rowsBelow = new Map(ends.map(({ root, end }) => [root, after.length - end]));
		// A batch offered before the switch still completes its handshake; no new
		// batch is offered while pinned.
		const history =
			this.#offeredHistory === undefined ? undefined : this.#offerHistory(transcript, width, rows, after.length);
		const lead = [...this.#header.render(width), ...this.#renderRoots(roots.slice(0, transcriptIndex), width)];
		const capacity = Math.max(0, rows - after.length);
		const now = performance.now();
		const selection = this.#selection;
		const window = transcript.renderScrollWindow(
			width,
			capacity,
			this.#scrollAnchor,
			this.#scrollDelta,
			{ now, tick: Math.floor(now / 80) },
			lead,
			selection?.region === "transcript",
		);
		this.#scrollAnchor = window.anchor;
		this.#scrollDelta = 0;
		this.#scrollCapacity = capacity;
		const content = window.rows.slice();
		if (selection?.region === "transcript" && window.top !== undefined && window.content && capacity > 0) {
			const top = window.top;
			const clampRow = (row: number): number => top + Math.min(capacity - 1, Math.max(0, row));
			selection.anchor ??= { row: clampRow(selection.press.row), col: selection.press.col };
			// Past the window's bottom the drag covers whole rows; above the top it starts at column 0.
			const head = selection.head;
			const headCol = head.row >= capacity ? Number.POSITIVE_INFINITY : head.row < 0 ? 0 : head.col;
			const [start, end] = orderSelection(selection.anchor, { row: clampRow(head.row), col: headCol });
			selection.range = { start, end, lines: window.content };
			for (let index = 0; index < content.length; index++) {
				content[index] = paintSelection(content[index]!, top + index, start, end);
			}
		} else if (selection?.region === "chrome" && after.length > 0) {
			const clampRow = (row: number): number => Math.min(after.length - 1, Math.max(0, row - capacity));
			selection.anchor ??= { row: clampRow(selection.press.row), col: selection.press.col };
			const [start, end] = orderSelection(selection.anchor, {
				row: clampRow(selection.head.row),
				col: selection.head.col,
			});
			selection.range = { start, end, lines: after.slice() };
			for (let index = 0; index < after.length; index++)
				after[index] = paintSelection(after[index]!, index, start, end);
		}
		// The follow hint would cover the row under a drag.
		if (window.anchor !== undefined && content.length > 0 && selection === undefined) {
			const label = ` ↓ ${window.below} more ${window.below === 1 ? "row" : "rows"} below — scroll down to follow `;
			content[content.length - 1] = theme.fg("dim", truncateToWidth(label, width, Ellipsis.Omit));
		}
		const gap = capacity - content.length;
		const mutable = [...content, ...Array<string>(gap).fill(""), ...after];
		const drop = Math.max(0, mutable.length - rows);
		const viewport = drop > 0 ? mutable.slice(drop) : mutable;
		const spans: ViewportClickSpan[] = [];
		const place = (span: ViewportClickSpan, base: number): void => {
			const start = span.start + base - drop;
			const end = Math.min(span.end + base - drop, viewport.length);
			const clamped = Math.max(0, start);
			if (end <= clamped) return;
			const skew = clamped - start;
			spans.push({ start: clamped, end, candidates: (local: number) => span.candidates(local + skew) });
		};
		for (const span of transcript.getLastViewportSpans()) {
			const ids = (span.component as Partial<{ getClickFocusAgentIds(): string[] }>).getClickFocusAgentIds?.();
			if (ids && ids.length > 0) place({ start: span.start, end: span.end, candidates: () => ids }, 0);
		}
		for (const span of afterSpans) place(span, capacity);
		this.#lastClickSpans = spans;
		return { history, viewport: this.#paintHoverBand(viewport, spans) };
	}

	/**
	 * Scroll the pinned-input transcript window by `rows` (negative = toward
	 * older rows). Scrolling back to the bottom resumes following new output.
	 * Returns false when the pinned layout is off, so callers can fall through.
	 */
	scrollTranscript(rows: number): boolean {
		if (!this.#preferences.pinnedInput || this.#stopped) return false;
		if (rows === 0) return true;
		this.#scrollDelta += Math.trunc(rows);
		this.ui.requestInteractiveRender();
		return true;
	}

	/** Scroll the pinned-input transcript window by one page in `direction`. */
	scrollTranscriptPage(direction: -1 | 1): boolean {
		return this.scrollTranscript(direction * Math.max(1, this.#scrollCapacity - PAGE_SCROLL_OVERLAP));
	}

	/** Jump the pinned-input transcript window back to the newest rows and follow them. */
	followTranscript(): void {
		if (this.#scrollAnchor === undefined && this.#scrollDelta === 0) return;
		this.#scrollAnchor = undefined;
		this.#scrollDelta = 0;
		this.ui.requestRender();
	}

	/**
	 * Start a mouse selection at a screen cell (0-based) in the pinned layout.
	 * Returns false when the pinned layout is off or the cell lies outside the
	 * painted viewport, so callers can treat the press as an ordinary click.
	 */
	beginSelection(screenRow: number, col: number): boolean {
		if (!this.#preferences.pinnedInput || this.#stopped) return false;
		const viewport = this.ui.getMutableViewport();
		const row = screenRow - viewport.top;
		if (viewport.length === 0 || row < 0 || row >= viewport.length) return false;
		this.#stopSelectionScroll();
		const point = { row, col: Math.max(0, col) };
		this.#selection = {
			region: row < this.#scrollCapacity ? "transcript" : "chrome",
			press: point,
			anchor: undefined,
			head: point,
			moved: false,
			following: this.#scrollAnchor === undefined,
		};
		this.ui.requestRender();
		return true;
	}

	/**
	 * Move the selection head to the pointer. A transcript drag held on the
	 * window's top row, or past its bottom into the chrome, keeps scrolling the
	 * window one row at a time so the selection can reach rows off screen.
	 */
	extendSelection(screenRow: number, col: number): void {
		const selection = this.#selection;
		if (selection === undefined) return;
		const row = screenRow - this.ui.getMutableViewport().top;
		selection.head = { row, col: Math.max(0, col) };
		selection.moved ||= row !== selection.press.row || col !== selection.press.col;
		if (selection.region === "transcript") {
			this.#setSelectionScroll(row <= 0 ? -1 : row >= this.#scrollCapacity ? 1 : 0);
		}
		this.ui.requestInteractiveRender();
	}

	/**
	 * End the selection and return its text, or undefined for a press that
	 * never dragged (an ordinary click). The highlight clears and the window
	 * resumes following when it rests at the bottom.
	 */
	finishSelection(): string | undefined {
		const selection = this.#selection;
		if (selection === undefined) return undefined;
		this.#stopSelectionScroll();
		this.#selection = undefined;
		if (selection.following) this.#scrollAnchor = undefined;
		this.ui.requestRender();
		const range = selection.range;
		if (!selection.moved || range === undefined) return undefined;
		const text = selectedText(range.lines, range.start, range.end);
		return text.trim() === "" ? undefined : text;
	}

	#setSelectionScroll(direction: -1 | 0 | 1): void {
		if (direction === this.#selectionScrollDirection) return;
		this.#stopSelectionScroll();
		if (direction === 0) return;
		// A drag that pulled older rows into view keeps them there on release.
		if (direction < 0 && this.#selection) this.#selection.following = false;
		this.#selectionScrollDirection = direction;
		this.scrollTranscript(direction);
		this.#selectionScrollTimer = setInterval(() => this.scrollTranscript(direction), SELECTION_SCROLL_INTERVAL_MS);
		this.#selectionScrollTimer.unref?.();
	}

	#stopSelectionScroll(): void {
		clearInterval(this.#selectionScrollTimer);
		this.#selectionScrollTimer = undefined;
		this.#selectionScrollDirection = 0;
	}

	/**
	 * Describe the whole surface for a TSP terminal. `main` is the flowing
	 * document: the header (welcome, extras) and every transcript block as its
	 * own component child. `dock` is the live chrome below the transcript in
	 * render order: pending messages, HUDs, the working row, the editor and the
	 * status line. There is no history/viewport split: retirement, resize
	 * replay and hover bands are ANSI concerns.
	 */
	describeSurface(): NativeSurface {
		if (!this.#started || this.#stopped) return this.#nativeSurface;
		const main: NativeChild[] = [...this.#header.children];
		const dock: NativeChild[] = [];
		if (!this.#runtimeMounted) {
			// The bootstrap gap is row spacing; the terminal owns the dock layout.
			dock.push(this.editor);
		} else {
			const roots = this.#runtimeChildren;
			const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
			if (transcriptIndex < 0) {
				dock.push(...roots);
			} else {
				const transcript = roots[transcriptIndex] as TranscriptContainer;
				main.push(...roots.slice(0, transcriptIndex), ...transcript.nativeBlocks());
				dock.push(...(this.#nativeDock ?? roots.slice(transcriptIndex + 1)));
			}
		}
		const previous = this.#nativeSurface;
		const nextMain = sameItems(previous.main, main) ? previous.main : main;
		const nextDock = sameItems(previous.dock, dock) ? previous.dock : dock;
		if (nextMain !== previous.main || nextDock !== previous.dock) {
			this.#nativeSurface = { main: nextMain, dock: nextDock };
		}
		return this.#nativeSurface;
	}

	/**
	 * Append one below-transcript root's rows to `after`, recording click spans
	 * for its row targets in `after` coordinates.
	 *
	 * Row targets usually nest one level down: chrome roots are plain
	 * containers (the HUD lives inside `subagentContainer`), and
	 * `Container.render` is a pure concatenation, so child spans tile the root
	 * span exactly. Render those children once and share the rows for
	 * composition and measurement — a second render per frame would duplicate
	 * render-time side effects (image placement registration). Roots with a
	 * custom render keep the composed output as the source of truth and measure
	 * up to the last target.
	 */
	#renderBelowRoot(root: Component, width: number, after: string[], spans: ViewportClickSpan[]): void {
		const start = after.length;
		const plainContainer = root instanceof Container && root.render === Container.prototype.render;
		const targets = root instanceof Container ? root.children : [root];
		const resolves = targets.map(rowTargetCandidates);
		const lastTarget = resolves.findLastIndex(resolve => resolve !== undefined);
		if (plainContainer) {
			let offset = start;
			for (let index = 0; index < targets.length; index++) {
				const childLines = targets[index]!.render(width);
				after.push(...childLines);
				if (index > lastTarget) continue;
				const resolve = resolves[index];
				if (resolve !== undefined && childLines.length > 0) {
					spans.push({ start: offset, end: offset + childLines.length, candidates: resolve });
				}
				offset += childLines.length;
			}
			return;
		}
		after.push(...root.render(width));
		if (lastTarget === -1) return;
		let offset = start;
		for (let index = 0; index <= lastTarget; index++) {
			const childLines = targets[index] === root ? after.length - start : targets[index]!.render(width).length;
			const resolve = resolves[index];
			if (resolve !== undefined && childLines > 0) {
				spans.push({ start: offset, end: offset + childLines, candidates: resolve });
			}
			offset += childLines;
		}
	}

	/**
	 * Band the hovered click target's current rows. Id-anchored (not
	 * line-anchored) so the band follows an agent whose rows shift while it
	 * streams; a retired id matches no span and simply paints nothing. Only
	 * the viewport copy is banded — retirement reads unbanded component rows.
	 */
	#paintHoverBand(viewport: string[], spans: readonly ViewportClickSpan[]): string[] {
		const hovered = this.#hoveredClickId;
		if (hovered === undefined) return viewport;
		let banded = false;
		const painted = viewport.map((line, index) => {
			for (const span of spans) {
				if (index < span.start || index >= span.end) continue;
				if (!span.candidates(index - span.start).includes(hovered)) continue;
				banded = true;
				// A wrapping band loses to background opens nested inside the row
				// (live card rows carry the pending-tint bg, which would paint over
				// the band for every cell it covers), so drop nested bg opens
				// first; their closes stay and become band resumes via bgFill.
				return theme.bgFill("selectedBg", line.replace(NESTED_BG_OPEN_PATTERN, ""));
			}
			return line;
		});
		return banded ? painted : viewport;
	}

	/**
	 * Candidate subagent ids under a mutable-viewport line, for click-to-focus.
	 * Empty when the line has no click target (chrome, separators, retired rows
	 * are never in the viewport). Callers intersect with the live registry.
	 */
	viewportClickCandidates(index: number): string[] {
		return routeViewportClick(this.#lastClickSpans, index);
	}

	/**
	 * Point the hover band at a click-candidate id (or clear it). Takes effect
	 * on the next frame; callers repaint only when the target actually changes.
	 */
	setHoveredClickId(id: string | undefined): void {
		this.#hoveredClickId = id;
	}

	/** Acknowledges one accepted header, replay, or transcript batch. */
	acknowledgeHistory(id: number): void {
		const offered = this.#offeredHistory;
		if (offered === undefined || offered.id !== id) return;
		if (offered.source === "header") {
			this.#headerRetired = true;
			this.#retiredHeaderRows = offered.rows;
		} else {
			if (offered.source.transcriptId !== undefined) {
				offered.source.transcript.acknowledgeFinalizedBatch(offered.source.transcriptId);
			}
			if (offered.source.header === "replay") {
				this.#headerReplayPending = false;
				if (offered.source.headerRows !== undefined) this.#retiredHeaderRows = offered.source.headerRows;
			}
		}
		this.#offeredHistory = undefined;
		if (this.#historyReplayRequested) this.#startHistoryReplay();
		if (offered.kind === "replay") {
			this.ui.requestRender();
		}
	}

	/** Render the semantic transcript tail while the terminal borrows its resize buffer. */
	renderResizeFrame(viewport: ViewportSize): readonly string[] {
		if (!this.#started || this.#stopped) return [];
		const width = Math.max(1, viewport.columns);
		const rows = Math.max(0, viewport.rows);
		const tail = this.#runtimeMounted
			? this.#renderResizeTail(width, rows)
			: this.#renderRoots([this.#bootstrapInputGap, this.editor, this.#statusHost], width);
		let header: readonly string[];
		if (this.#headerRetired) {
			this.#resizeRetiredHeaderStart ??= Math.max(
				0,
				this.#retiredHeaderStart - Math.max(0, rows - this.#lastNormalRows),
			);
			header = this.#reflowRetiredHeader(width, this.#resizeRetiredHeaderStart);
		} else {
			header = this.#header.render(width);
		}
		const rendered = [...header, ...tail];
		return rendered.length <= rows ? rendered : rendered.slice(rendered.length - rows);
	}

	/** Replays committed presentation without changing logical retirement state. */
	beginHistoryReplay(): void {
		if (this.#offeredHistory !== undefined) {
			this.#historyReplayRequested = true;
			return;
		}
		this.#startHistoryReplay();
	}

	/** Forces every currently eligible finalized prefix to retire before stop. */
	beginHistoryFlush(): void {
		this.#historyFlush = true;
		// A pending replay would re-render and re-stream the entire committed
		// ledger during shutdown; the terminal already holds that history, so
		// flush emits only genuinely un-retired rows. An already offered batch
		// stays valid and is accepted by the flush loop.
		this.#historyReplayRequested = false;
		this.#headerReplayPending = false;
		for (const child of this.#runtimeChildren) {
			if (child instanceof TranscriptContainer) child.cancelReplay();
		}
	}

	#startHistoryReplay(): void {
		this.#headerReplayPending = this.#headerRetired && (this.#retiredHeaderRows?.length ?? 0) > 0;
		this.#historyReplayRequested = false;
		for (const child of this.#runtimeChildren) {
			if (child instanceof TranscriptContainer) child.beginReplay();
		}
	}

	/** Header retires first; replay coalesces it with the complete transcript ledger. */
	#offerHistory(
		transcript: TranscriptContainer,
		width: number,
		rows: number,
		chromeRows: number,
	): { id: number; rows: readonly string[]; kind: "append" | "replay" } | undefined {
		if (this.#offeredHistory !== undefined) {
			this.#rerenderOfferedHistory(width);
			return {
				id: this.#offeredHistory.id,
				rows: this.#offeredHistory.rows,
				kind: this.#offeredHistory.kind,
			};
		}
		if (this.#headerReplayPending) {
			const transcriptReplay = transcript.peekReplayBatch(width);
			// A replay follows a scrollback clear, so the header recomposes at
			// the new width exactly like transcript entries do. An empty
			// recompose (welcome unmounted after retirement) falls back to the
			// committed rows, hard-wrapped the way the terminal would.
			const recomposed = this.#header.render(width);
			const headerRows = recomposed.length > 0 ? [...recomposed, ""] : this.#reflowRetiredHeader(width, 0);
			this.#offeredHistory = {
				id: this.#nextHistoryId++,
				rows: [...headerRows, ...(transcriptReplay?.rows ?? [])],
				kind: "replay",
				source: {
					transcript,
					transcriptId: transcriptReplay?.id,
					header: "replay",
					headerRows,
				},
			};
			return {
				id: this.#offeredHistory.id,
				rows: this.#offeredHistory.rows,
				kind: this.#offeredHistory.kind,
			};
		}
		if (!this.#headerRetired) {
			const welcome = this.#welcome;
			if (welcome !== undefined && !welcome.isTranscriptBlockFinalized()) return undefined;
			// The header stays live viewport chrome until the screen fills; then it
			// retires first so transcript prefixes can follow in order.
			const renderedHeader = this.#header.render(width);
			if (renderedHeader.length > 0) {
				// Only the comparison below reads the height, so the walk stops at
				// the budget instead of rendering every replayed block (#12933).
				const liveRows = transcript.liveRowCount(width, Math.max(0, rows - renderedHeader.length - chromeRows));
				if (!this.#historyFlush && renderedHeader.length + chromeRows + liveRows <= rows) return undefined;
				this.#offeredHistory = {
					id: this.#nextHistoryId++,
					rows: [...renderedHeader, ""],
					kind: "append",
					source: "header",
				};
				return {
					id: this.#offeredHistory.id,
					rows: this.#offeredHistory.rows,
					kind: this.#offeredHistory.kind,
				};
			}
			this.#headerRetired = true;
			this.#retiredHeaderRows = [];
		}
		const batch = this.#historyFlush
			? transcript.peekFlushBatch(width)
			: transcript.peekFinalizedBatch(width, Math.max(0, rows - chromeRows));
		if (batch === undefined) return undefined;
		this.#offeredHistory = {
			id: this.#nextHistoryId++,
			rows: batch.rows,
			kind: batch.kind ?? "append",
			source: { transcript, transcriptId: batch.id, header: "none" },
		};
		return {
			id: this.#offeredHistory.id,
			rows: this.#offeredHistory.rows,
			kind: this.#offeredHistory.kind,
		};
	}

	#rerenderOfferedHistory(width: number): void {
		const offered = this.#offeredHistory;
		if (offered === undefined) return;
		if (offered.source === "header") {
			const rows = this.#header.render(width);
			offered.rows = rows.length > 0 ? [...rows, ""] : [];
			return;
		}
		const transcript = offered.source.transcript.rerenderOfferedBatch(width);
		if (offered.source.header === "none") {
			if (transcript !== undefined) offered.rows = transcript.rows;
			return;
		}
		const recomposed = this.#header.render(width);
		const headerRows = recomposed.length > 0 ? [...recomposed, ""] : this.#reflowRetiredHeader(width, 0);
		offered.source.headerRows = headerRows;
		offered.rows = [...headerRows, ...(transcript?.rows ?? [])];
	}

	#renderRoots(roots: readonly Component[], width: number): string[] {
		const rows: string[] = [];
		for (const root of roots) rows.push(...root.render(width));
		return rows;
	}
	/**
	 * Mounted-runtime rows for the transient resize buffer. Only the trailing
	 * viewport can survive the caller's bottom slice, so the transcript renders
	 * a bounded tail instead of the full committed ledger, and the chrome above
	 * it renders only when that tail underfills the screen.
	 */
	#renderResizeTail(width: number, rows: number): string[] {
		const roots = [...this.#runtimeChildren, this.#statusHost];
		const transcriptIndex = roots.findIndex(root => root instanceof TranscriptContainer);
		if (transcriptIndex < 0) return this.#renderRoots(roots, width);
		const transcript = roots[transcriptIndex] as TranscriptContainer;
		const after = this.#renderRoots(roots.slice(transcriptIndex + 1), width);
		const transcriptRows = transcript.renderTail(width, Math.max(0, rows - after.length));
		const pre =
			transcriptRows.length + after.length >= rows ? [] : this.#renderRoots(roots.slice(0, transcriptIndex), width);
		return [...pre, ...transcriptRows, ...after];
	}

	/** Reflow accepted hard rows exactly as the restored terminal buffer will. */
	#reflowRetiredHeader(width: number, start: number): string[] {
		const lines = this.#retiredHeaderRows;
		if (!lines) return [];
		if (isInsideTerminalMultiplexer()) return lines.slice(start);
		const reflowed: string[] = [];
		for (let index = start; index < lines.length; index++) {
			reflowed.push(...wrapLiteralLine(lines[index]!, width));
		}
		return reflowed;
	}

	/** Live editor whose draft survives startup and session adoption. */
	get editor(): CustomEditor {
		return this.#editor;
	}

	/** The welcome component currently mounted in the header, if quiet mode is off. */
	get welcome(): WelcomeComponent | undefined {
		return this.#welcome;
	}

	/** Whether this composer already owns the terminal render/input loop. */
	get started(): boolean {
		return this.#started && !this.#stopped;
	}

	/** Start terminal ownership and optionally begin the welcome intro. */
	start(options: ComposerStartOptions = {}): void {
		if (this.#started || this.#stopped) return;
		this.#started = true;
		this.ui.start({ clearScrollback: options.clearScrollback === true, deferInput: options.deferInput === true });
		if (options.playWelcomeIntro !== false) this.playWelcomeIntro();
		// Deferred input identifies the CLI prepaint handoff. Flush the queued
		// forced frame before returning so subsequent dynamic-import evaluation
		// cannot monopolize the event loop ahead of the speculative status chrome.
		if (options.deferInput === true) this.ui.renderNow({ clearScrollback: options.clearScrollback === true });
	}
	/** Take raw-input ownership after a deferred-input start. Idempotent. */
	enableInput(): void {
		if (this.#stopped) return;
		this.ui.enableInput();
	}

	/** Apply settings changes without replacing the editor or welcome component. */
	setPreferences(update: Partial<ComposerPreferences>): void {
		if (this.#stopped) return;
		const wasQuiet = this.#preferences.quiet;
		const wasPinned = this.#preferences.pinnedInput;
		this.#preferences = { ...this.#preferences, ...update };
		if (wasPinned !== this.#preferences.pinnedInput) {
			this.#scrollAnchor = undefined;
			this.#scrollDelta = 0;
			this.#selection = undefined;
			this.#stopSelectionScroll();
		}
		this.editor.setTheme(getEditorTheme());
		try {
			this.editor.setBorderStyle(this.#preferences.composerShape);
		} catch {
			// Extension-defined styles arrive with the session; InteractiveMode reapplies them.
		}
		this.ui.setShowHardwareCursor(this.#preferences.showHardwareCursor);
		this.editor.setUseTerminalCursor(this.ui.getShowHardwareCursor());
		this.ui.setMaxInlineImages(this.#preferences.maxInlineImages);
		if (update.resizeScrollback !== undefined) this.ui.setResizeScrollback(update.resizeScrollback);
		this.editor.setImeSafeCursorLayout(this.#preferences.imeSafeCursor);
		this.editor.setAutocompleteMaxVisible(this.#preferences.autocompleteMaxVisible);
		this.editor.setSpellingFeatures({
			typoDetection: this.#preferences.spellingTypoDetection,
			autocomplete: this.#preferences.spellingAutocomplete,
			autocorrect: this.#preferences.spellingAutocorrect,
		});
		this.#startupStatus?.attachToEditor(this.editor, getComposerStyle(this.#preferences.composerShape));
		if (this.#preferences.quiet) {
			this.#welcome?.stopIntro();
			this.#welcome = undefined;
		} else {
			this.#ensureWelcome();
			this.#welcome?.invalidate();
			if (wasQuiet && this.#started) this.playWelcomeIntro();
		}
		if (wasQuiet !== this.#preferences.quiet) this.#rebuildHeader();
		this.ui.requestRender();
	}

	/** Patch welcome data in place as version, session, and project discovery complete. */
	updateWelcome(update: ComposerWelcomeUpdate): void {
		if (this.#stopped) return;
		this.#applyWelcomeUpdate(update);
		if (this.#preferences.quiet) return;
		this.#ensureWelcome();
		const welcome = this.#welcome;
		if (!welcome) return;
		if (update.version !== undefined) welcome.setVersion(this.#version);
		this.ui.requestRender();
	}

	/** Replace optional header content around the stable welcome scene. */
	setHeaderExtras(before: readonly Component[], after: readonly Component[]): void {
		if (this.#stopped) return;
		this.#headerBefore = before;
		this.#headerAfter = after;
		this.#rebuildHeader();
		this.ui.requestRender();
	}

	/** Update the canonical editor reference after InteractiveMode remounts a custom editor. */
	setEditor(editor: CustomEditor): void {
		this.ui.replaceHeldFocus(this.#editor, editor);
		this.#editor = editor;
	}

	/**
	 * Mount the session-aware status component into the slot below the editor,
	 * retiring the startup status line; the caller installs the real top-border
	 * provider through its composer-shape sync.
	 */
	setStatusComponent<TSession extends StatusLineSession>(component: StatusLineComponent<TSession>): void {
		if (this.#startupStatus) component.adoptGitStatus(this.#startupStatus);
		this.#disposeStartupStatus();
		this.#statusHost.setComponent(component);
		this.editor.setTopBorderProvider(undefined);
		this.editor.composerFacts = component;
	}

	#disposeStartupStatus(): void {
		this.#startupStatus?.dispose();
		this.#startupStatus = undefined;
	}

	/** Mount or replace session-aware root children while preserving the header and status hosts. */
	setRuntimeChildren(children: readonly Component[], options: RuntimeChildrenOptions = {}): void {
		if (this.#stopped) return;
		this.#transientChrome = new Set(options.transient);
		this.#transientChromeFloor = undefined;
		this.#anchorAfterInlineRetirement = false;
		this.#nativeDock = options.nativeDock;
		this.ui.removeChild(this.#statusHost);
		if (this.#runtimeMounted) {
			for (const child of this.#runtimeChildren) this.ui.removeChild(child);
		} else {
			this.ui.removeChild(this.#bootstrapInputGap);
			this.ui.removeChild(this.editor);
			this.#runtimeMounted = true;
		}
		this.#runtimeChildren = children;
		for (const child of children) this.ui.addChild(child);
		this.ui.addChild(this.#statusHost);
		this.ui.requestRender();
	}

	/** Play or replay the welcome intro against the stable header render target. */
	playWelcomeIntro(): void {
		this.#welcome?.playIntro(() => this.ui.requestComponentRender(this.#header));
	}

	/** Transfer terminal ownership to InteractiveMode without stopping the composer. */
	transfer(): void {
		if (!this.#started || this.#stopped || this.#transferred) {
			throw new Error("Composer is not available for transfer");
		}
		this.#transferred = true;
	}

	/** Stop a composer that has not transferred terminal ownership. */
	stop(): void {
		if (!this.#started || this.#stopped || this.#transferred) return;
		this.#welcome?.stopIntro();
		this.#disposeStartupStatus();
		this.ui.stop();
		this.#stopped = true;
	}

	#applyWelcomeUpdate(update: ComposerWelcomeUpdate): void {
		if (update.version !== undefined) this.#version = update.version;
	}

	#ensureWelcome(): void {
		this.#welcome ??= new WelcomeComponent(this.#version);
	}

	#rebuildHeader(): void {
		this.#header.clear();
		for (const component of this.#headerBefore) this.#header.addChild(component);
		if (this.#welcome) {
			this.#header.addChild(new Spacer(1));
			this.#header.addChild(this.#welcome);
			this.#header.addChild(new Spacer(1));
		}
		for (const component of this.#headerAfter) this.#header.addChild(component);
	}

	#handleInterrupt(): void {
		const now = this.#now();
		if (now - this.#lastInterruptAt < DOUBLE_INTERRUPT_MS) {
			this.#requestExit(130);
			return;
		}
		this.editor.setText("");
		this.#lastInterruptAt = now;
	}

	#requestExit(code: number): void {
		// Remains live after transfer until InteractiveMode installs its configured handlers.
		if (this.#stopped) return;
		this.#welcome?.stopIntro();
		if (this.#started) this.ui.stop();
		this.#stopped = true;
		this.#exit(code);
	}
}
