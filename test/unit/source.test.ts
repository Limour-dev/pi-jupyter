/**
 * Unit tests: the read-only cell-SOURCE selection behind `jupyter_read_cells`
 * (pure domain logic). No Jupyter Server, no network — runs offline.
 *
 * The point of the feature: an agent borrows code from a notebook it never
 * opens, so the tests lock in that (a) code cells are read from the FILE,
 * (b) a query finds the cells implementing something, and (c) nothing floods
 * the context — cells/lines are capped and the omission is reported.
 */
import { describe, expect, it } from "vitest";
import { parseNotebook } from "../../src/domain/notebook";
import {
  cellSourceHeader,
  cellSources,
  compileCellQuery,
  DEFAULT_MAX_CELLS,
  DEFAULT_MAX_LINES,
  selectCellSources,
} from "../../src/domain/source";

function model() {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } },
    cells: [
      {
        cell_type: "markdown",
        id: "md-intro",
        metadata: {},
        source: ["# Analysis\n", "Loads the cohort."],
      },
      {
        cell_type: "code",
        id: "load",
        metadata: {},
        execution_count: 3,
        source: "import pandas as pd\ndf = pd.read_csv('cohort.csv')\n",
        outputs: [],
      },
      {
        cell_type: "code",
        id: "clean",
        metadata: {},
        execution_count: 4,
        source: ["df = df.dropna()\n", "df['y'] = df['x'] ** 2"],
        outputs: [{ output_type: "stream", name: "stdout", text: "ok\n" }],
      },
      {
        cell_type: "raw",
        id: "raw-note",
        metadata: {},
        source: "keep this verbatim",
      },
      {
        cell_type: "code",
        id: "broken",
        metadata: {},
        execution_count: 5,
        source: "raise ValueError('boom')",
        outputs: [
          { output_type: "error", ename: "ValueError", evalue: "boom", traceback: [] },
        ],
      },
    ],
  };
}

const slots = parseNotebook(model()).slots;

describe("cellSources", () => {
  it("projects every cell in document order, keeping the document index", () => {
    const cells = cellSources(slots);
    expect(cells.map((c) => [c.index, c.cellId, c.kind])).toEqual([
      [0, "md-intro", "markdown"],
      [1, "load", "code"],
      [2, "clean", "code"],
      [3, "raw-note", "raw"],
      [4, "broken", "code"],
    ]);
  });

  it("joins nbformat line arrays back to plain source", () => {
    const clean = cellSources(slots).find((c) => c.cellId === "clean");
    expect(clean?.source).toBe("df = df.dropna()\ndf['y'] = df['x'] ** 2");
  });

  it("reports execution count and whether the recorded run failed", () => {
    const byId = new Map(cellSources(slots).map((c) => [c.cellId, c]));
    expect(byId.get("load")?.executionCount).toBe(3);
    expect(byId.get("broken")?.error).toBe(true);
    expect(byId.get("clean")?.error).toBe(false);
  });

  it("synthesizes an id for a markdown cell without one", () => {
    const parsed = parseNotebook({
      cells: [{ cell_type: "markdown", metadata: {}, source: "no id" }],
    });
    expect(cellSources(parsed.slots)[0].cellId).toBe("cell-0");
  });
});

describe("compileCellQuery", () => {
  it("returns undefined for an absent/blank query", () => {
    expect(compileCellQuery(undefined)).toBeUndefined();
    expect(compileCellQuery("   ")).toBeUndefined();
  });

  it("matches case-insensitive literal substrings (no escaping needed)", () => {
    const m = compileCellQuery("DF['Y']");
    expect(m?.("df['y'] = 1")).toBe(true);
    expect(m?.("x = 2")).toBe(false);
  });

  it("treats /…/ as a case-insensitive regex", () => {
    const m = compileCellQuery("/^def \\w+/");
    expect(m?.("def fit(): pass")).toBe(true);
    expect(m?.("x = 1\ndef fit(): pass")).toBe(false);
  });

  it("reports an invalid regex instead of matching nothing", () => {
    expect(() => compileCellQuery("/(unclosed/")).toThrow(/invalid regex query/);
  });
});

describe("selectCellSources", () => {
  it("returns CODE cells only by default", () => {
    const sel = selectCellSources(slots);
    expect(sel.cells.map((c) => c.cellId)).toEqual(["load", "clean", "broken"]);
    expect(sel.total).toBe(5);
    expect(sel.candidates).toBe(3);
    expect(sel.matched).toBe(3);
    expect(sel.markdownHidden).toBe(true);
  });

  it("includeMarkdown adds the markdown/raw cells", () => {
    const sel = selectCellSources(slots, { includeMarkdown: true });
    expect(sel.cells.map((c) => c.kind)).toEqual(["markdown", "code", "code", "raw", "code"]);
    expect(sel.markdownHidden).toBe(false);
  });

  it("filters by a literal query", () => {
    const sel = selectCellSources(slots, { query: "read_csv" });
    expect(sel.cells.map((c) => c.cellId)).toEqual(["load"]);
    expect(sel.matched).toBe(1);
  });

  it("returns no matches (not an error) for a query nothing satisfies", () => {
    const sel = selectCellSources(slots, { query: "no such thing" });
    expect(sel.shown).toBe(0);
    expect(sel.matched).toBe(0);
  });

  it("reads one cell by id — even a markdown one", () => {
    const code = selectCellSources(slots, { cellId: "clean" });
    expect(code.cells.map((c) => c.cellId)).toEqual(["clean"]);
    expect(code.candidates).toBe(5); // an explicit id looks at every cell kind

    const md = selectCellSources(slots, { cellId: "md-intro" });
    expect(md.cells[0].kind).toBe("markdown");
    expect(md.cells[0].text).toContain("Loads the cohort.");
  });

  it("rejects an unknown cell id instead of looking like an empty notebook", () => {
    expect(() => selectCellSources(slots, { cellId: "nope" })).toThrow(/no cell with id "nope"/);
  });

  it("pages with offset/maxCells and reports what was omitted", () => {
    const first = selectCellSources(slots, { maxCells: 2 });
    expect(first.cells.map((c) => c.cellId)).toEqual(["load", "clean"]);
    expect(first.shown).toBe(2);
    expect(first.omitted).toBe(1);
    expect(first.offset).toBe(0);

    const second = selectCellSources(slots, { maxCells: 2, offset: 2 });
    expect(second.cells.map((c) => c.cellId)).toEqual(["broken"]);
    expect(second.offset).toBe(2);
    expect(second.omitted).toBe(0);
  });

  it("defaults the caps and clamps bad values", () => {
    expect(DEFAULT_MAX_CELLS).toBe(20);
    expect(DEFAULT_MAX_LINES).toBe(120);
    const sel = selectCellSources(slots, { maxCells: 0, maxLines: -5, offset: -3 });
    expect(sel.cells).toHaveLength(1); // clamped to a minimum of 1 cell
    expect(sel.cells[0].truncated).toBe(true); // clamped to a minimum of 1 line
    expect(sel.cells[0].lines).toBe(2);
    expect(sel.cells[0].omittedLines).toBe(1);
    expect(sel.cells[0].text).toBe("import pandas as pd");
    expect(sel.offset).toBe(0);
  });

  it("head-truncates a long cell and counts the omitted lines", () => {
    const parsed = parseNotebook({
      cells: [
        {
          cell_type: "code",
          id: "long",
          metadata: {},
          execution_count: null,
          source: Array.from({ length: 50 }, (_, i) => `line ${i}\n`).join(""),
          outputs: [],
        },
      ],
    });
    const sel = selectCellSources(parsed.slots, { maxLines: 3 });
    const cell = sel.cells[0];
    expect(cell.truncated).toBe(true);
    expect(cell.lines).toBe(50);
    expect(cell.omittedLines).toBe(47);
    expect(cell.text).toBe("line 0\nline 1\nline 2");
  });

  it("does not count the file's final newline as an extra line", () => {
    const parsed = parseNotebook({
      cells: [{ cell_type: "code", id: "one", metadata: {}, source: "x = 1\n", outputs: [] }],
    });
    const sel = selectCellSources(parsed.slots);
    expect(sel.cells[0].lines).toBe(1);
    expect(sel.cells[0].text).toBe("x = 1");
  });

  it("reports an empty document without throwing", () => {
    const sel = selectCellSources([], {});
    expect(sel).toMatchObject({ total: 0, matched: 0, shown: 0, omitted: 0 });
  });
});

describe("cellSourceHeader", () => {
  it("names the index, id, kind and recorded run", () => {
    const sel = selectCellSources(slots, { maxCells: 3 });
    expect(cellSourceHeader(sel.cells[0])).toBe("[1] load (code, exec 3, 2 lines)");
    expect(cellSourceHeader(sel.cells[2])).toBe(
      "[4] broken (code, exec 5, 1 line, recorded run FAILED)",
    );
  });

  it("marks a never-run cell and a markdown cell", () => {
    const never = selectCellSources(
      parseNotebook({
        cells: [{ cell_type: "code", id: "fresh", metadata: {}, source: "pass", outputs: [] }],
      }).slots,
    );
    expect(cellSourceHeader(never.cells[0])).toBe("[0] fresh (code, never run, 1 line)");

    const md = selectCellSources(slots, { cellId: "md-intro" });
    expect(cellSourceHeader(md.cells[0])).toBe("[0] md-intro (markdown, 2 lines)");
  });
});
