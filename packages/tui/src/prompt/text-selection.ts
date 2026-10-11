/**
 * Row/column text selection over rendered ANSI rows, for the pinned-input
 * layout's own mouse selection (`tui.mouseSelection`): the terminal's native
 * selection is unavailable while omp captures the mouse for wheel scrolling.
 */
import { sliceByColumn, visibleWidth } from "../utils";

/** A cell in rendered rows: 0-based row and display column. */
export interface SelectionPoint {
	readonly row: number;
	readonly col: number;
}

/** Order two points top-to-bottom, left-to-right. */
export function orderSelection(a: SelectionPoint, b: SelectionPoint): [SelectionPoint, SelectionPoint] {
	return a.row < b.row || (a.row === b.row && a.col <= b.col) ? [a, b] : [b, a];
}

/**
 * Columns `[from, to)` of `row` inside the ordered range `start..end`, which
 * includes the cell under `end`; `to` is `Infinity` for rows the range spans to
 * their end. Undefined for rows outside the range.
 */
function rowColumns(row: number, start: SelectionPoint, end: SelectionPoint): { from: number; to: number } | undefined {
	if (row < start.row || row > end.row) return undefined;
	return {
		from: row === start.row ? Math.max(0, start.col) : 0,
		to: row === end.row ? end.col + 1 : Number.POSITIVE_INFINITY,
	};
}

/** Plain text of the ordered range over `lines` (indexed by row), one line per row, trailing blanks dropped. */
export function selectedText(lines: readonly string[], start: SelectionPoint, end: SelectionPoint): string {
	const out: string[] = [];
	for (let row = start.row; row <= end.row; row++) {
		const line = lines[row] ?? "";
		const columns = rowColumns(row, start, end)!;
		const width = visibleWidth(line);
		const to = Math.min(columns.to, width);
		out.push(to > columns.from ? Bun.stripANSI(sliceByColumn(line, columns.from, to - columns.from)).trimEnd() : "");
	}
	return out.join("\n");
}

/**
 * Paint `line` (content row `row`) in reverse video where the ordered range
 * covers it, up to the line's visible end. Resets inside the slice re-arm the
 * reverse attribute so styled spans stay highlighted.
 */
export function paintSelection(line: string, row: number, start: SelectionPoint, end: SelectionPoint): string {
	const columns = rowColumns(row, start, end);
	if (columns === undefined) return line;
	const width = visibleWidth(line);
	const to = Math.min(columns.to, width);
	if (to <= columns.from) return line;
	const before = sliceByColumn(line, 0, columns.from);
	const middle = sliceByColumn(line, columns.from, to - columns.from).replace(
		/\x1b\[0?m/g,
		reset => `${reset}\x1b[7m`,
	);
	const after = to < width ? sliceByColumn(line, to, width - to) : "";
	return `${before}\x1b[7m${middle}\x1b[27m${after}`;
}
