/**
 * Read-only cell-source view of a notebook FILE (`jupyter_read_cells`).
 *
 * Why it exists: an agent that needs to borrow an existing implementation
 * (a plotting helper, a data-cleaning pipeline, a model-fitting recipe) should
 * not have to OPEN that notebook — opening starts/attaches a kernel and, when
 * no kernel is live, REPLAYS the whole file. Reading the sources is enough:
 * parse the `.ipynb` (`parseNotebook`), project its slots to sources, filter by
 * id / query, and cap the rendered text so one huge notebook cannot flood the
 * context window.
 *
 * Nothing here touches a kernel, the server, or the document’s outputs — it is
 * pure and unit-tested offline.
 */
import { joinText, type NotebookSlot } from "./notebook";

/** How a cell is presented to the agent (code is executed, the rest is text). */
export type CellKind = "code" | "markdown" | "raw";

/** One cell of a notebook file, reduced to what a source reader needs. */
export type CellSource = {
  /** 0-based position in the DOCUMENT (counts every cell, code and not). */
  index: number;
  /** Cell id as recorded in the file (a synthesized one when the file has none). */
  cellId: string;
  kind: CellKind;
  source: string;
  /** Recorded execution count of a code cell (`null` = never run). */
  executionCount: number | null;
  /** A code cell whose recorded outputs contain an error. */
  error: boolean;
};

/** What to select from a notebook's cells. */
export type CellSourceQuery = {
  /** Only this cell id (wins over the kind filter: markdown/raw ids resolve too). */
  cellId?: string;
  /**
   * Case-insensitive source filter. Wrapped in slashes (`/^def fit_/`) it is a
   * JavaScript regex, anything else is a LITERAL substring (so `df["x"]` needs
   * no escaping).
   */
  query?: string;
  /** Include markdown/raw cells (documentation, headings) besides code. */
  includeMarkdown?: boolean;
  /** 0-based offset among the MATCHING cells, for paging. */
  offset?: number;
  /** Max cells to return (default {@link DEFAULT_MAX_CELLS}). */
  maxCells?: number;
  /** Max source lines per cell (default {@link DEFAULT_MAX_LINES}). */
  maxLines?: number;
};

/** One selected cell, with the text that will actually be rendered. */
export type CellSourceMatch = Omit<CellSource, "source"> & {
  /** Lines in the FULL source. */
  lines: number;
  /** The returned source (head-truncated to `maxLines`). */
  text: string;
  truncated: boolean;
  /** Lines dropped by the per-cell cap. */
  omittedLines: number;
};

export type CellSourceSelection = {
  cells: CellSourceMatch[];
  /** Every cell in the document. */
  total: number;
  /** Cells of the requested kinds, BEFORE the id/query filter. */
  candidates: number;
  /** Cells matching the id/query filter. */
  matched: number;
  /** Cells actually returned (`matched` minus the offset and the cap). */
  shown: number;
  offset: number;
  /** Matching cells skipped after the returned window. */
  omitted: number;
  /** The document holds markdown/raw cells that were NOT returned (hidden). */
  markdownHidden: boolean;
};

export const DEFAULT_MAX_CELLS = 20;
export const DEFAULT_MAX_LINES = 120;
export const MAX_CELLS_LIMIT = 200;
export const MAX_LINES_LIMIT = 5000;

/**
 * Build a source matcher for {@link CellSourceQuery.query}.
 *
 * `/…/` is a case-insensitive regex (an invalid pattern throws, so a typo is
 * reported instead of silently matching nothing); every other string is a
 * case-insensitive literal substring.
 */
export function compileCellQuery(query: string | undefined): ((source: string) => boolean) | undefined {
  const raw = query?.trim();
  if (!raw) return undefined;
  if (raw.length >= 2 && raw.startsWith("/") && raw.endsWith("/")) {
    const pattern = raw.slice(1, -1);
    let re: RegExp;
    try {
      re = new RegExp(pattern, "i");
    } catch (err) {
      throw new Error(`invalid regex query ${raw}: ${(err as Error).message}`);
    }
    return (source) => re.test(source);
  }
  const needle = raw.toLowerCase();
  return (source) => source.toLowerCase().includes(needle);
}

/** Project a parsed notebook document to its cell sources (document order). */
export function cellSources(slots: NotebookSlot[]): CellSource[] {
  const out: CellSource[] = [];
  slots.forEach((slot, index) => {
    if (slot.kind === "code") {
      out.push({
        index,
        cellId: slot.cellId,
        kind: "code",
        source: slot.source,
        executionCount: slot.result.executionCount ?? null,
        error: (slot.result.outputs ?? []).some((o) => o.outputType === "error"),
      });
      return;
    }
    const raw = (slot.raw ?? {}) as Record<string, unknown>;
    const kind: CellKind = raw.cell_type === "markdown" ? "markdown" : "raw";
    out.push({
      index,
      cellId:
        typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `cell-${index}`,
      kind,
      source: joinText(raw.source ?? raw.text),
      executionCount: null,
      error: false,
    });
  });
  return out;
}

function clampInt(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value), 1), max);
}

/** Strip trailing newlines so a file's final `\n` is not counted as a line. */
function trimTrailingNewlines(source: string): string {
  return source.replace(/[\r\n]+$/, "");
}

/**
 * Select the cells to render: id/kind/query filter → offset → per-cell line cap.
 * Throws when an explicit `cellId` does not exist (a typo must not look like an
 * empty notebook) or when a regex `query` is malformed.
 */
export function selectCellSources(
  slots: NotebookSlot[],
  q: CellSourceQuery = {},
): CellSourceSelection {
  const all = cellSources(slots);
  const includeMarkdown = q.includeMarkdown === true;
  const wantedId = q.cellId?.trim();
  const matcher = compileCellQuery(q.query);
  const candidates = all.filter((c) => (wantedId ? true : c.kind === "code" || includeMarkdown));
  const matched = candidates.filter(
    (c) => (!wantedId || c.cellId === wantedId) && (!matcher || matcher(c.source)),
  );
  if (wantedId && matched.length === 0) {
    throw new Error(`no cell with id "${wantedId}" in this notebook`);
  }
  const maxCells = clampInt(q.maxCells, DEFAULT_MAX_CELLS, MAX_CELLS_LIMIT);
  const maxLines = clampInt(q.maxLines, DEFAULT_MAX_LINES, MAX_LINES_LIMIT);
  const offset = Math.max(Math.trunc(q.offset ?? 0) || 0, 0);
  const windowed = matched.slice(offset, offset + maxCells);
  const cells: CellSourceMatch[] = windowed.map((cell) => {
    const trimmed = trimTrailingNewlines(cell.source);
    const lines: string[] = trimmed === "" ? [] : trimmed.split("\n");
    const kept = lines.length > maxLines ? lines.slice(0, maxLines) : lines;
    return {
      index: cell.index,
      cellId: cell.cellId,
      kind: cell.kind,
      executionCount: cell.executionCount,
      error: cell.error,
      lines: lines.length,
      text: kept.join("\n"),
      truncated: lines.length > maxLines,
      omittedLines: Math.max(lines.length - maxLines, 0),
    };
  });
  return {
    cells,
    total: all.length,
    candidates: candidates.length,
    matched: matched.length,
    shown: cells.length,
    offset,
    omitted: Math.max(matched.length - offset - cells.length, 0),
    // Only a note about a HIDDEN filter: an explicit cell id bypasses the kind
    // filter, so it never hides anything the caller asked for.
    markdownHidden: !includeMarkdown && !wantedId && all.some((c) => c.kind !== "code"),
  };
}

/**
 * One-line header for a rendered cell: document index, id, kind, execution
 * count, size, and whether its last recorded run failed.
 */
export function cellSourceHeader(cell: CellSourceMatch): string {
  const bits: string[] = [cell.kind];
  if (cell.kind === "code") {
    bits.push(cell.executionCount === null ? "never run" : `exec ${cell.executionCount}`);
  }
  bits.push(cell.lines === 1 ? "1 line" : `${cell.lines} lines`);
  if (cell.error) bits.push("recorded run FAILED");
  return `[${cell.index}] ${cell.cellId} (${bits.join(", ")})`;
}
