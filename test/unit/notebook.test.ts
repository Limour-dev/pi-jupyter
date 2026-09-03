/**
 * Unit tests: notebook serializer (nbformat 4.5 structure).
 */
import { describe, expect, it } from "vitest";
import { buildNotebook, buildNotebookFromSlots, parseNotebook, splitLines, type CellRecord } from "../../src/domain/notebook";
import { normalizeMimebundle } from "../../src/domain/output";

describe("splitLines", () => {
  it("keeps trailing \\n on all but the last line", () => {
    expect(splitLines("a\nb\nc")).toEqual(["a\n", "b\n", "c"]);
  });
  it("handles a single line", () => {
    expect(splitLines("hello")).toEqual(["hello"]);
  });
  it("handles empty string", () => {
    expect(splitLines("")).toEqual([""]);
  });
});

describe("buildNotebook", () => {
  it("produces a valid nbformat 4.5 skeleton", () => {
    const nb = buildNotebook([]) as any;
    expect(nb.nbformat).toBe(4);
    expect(nb.nbformat_minor).toBe(5);
    expect(nb.metadata.kernelspec.language).toBe("python");
    expect(nb.cells).toEqual([]);
  });

  it("defaults the kernelspec header to Python 3", () => {
    const nb = buildNotebook([]) as any;
    expect(nb.metadata.kernelspec).toEqual({
      display_name: "Python 3",
      language: "python",
      name: "python3",
    });
    expect(nb.metadata.language_info).toEqual({ name: "python" });
  });

  it("uses the supplied kernelspec metadata (R example)", () => {
    const nb = buildNotebook([], {
      kernelName: "ir",
      displayName: "R",
      language: "r",
    }) as any;
    expect(nb.metadata.kernelspec.name).toBe("ir");
    expect(nb.metadata.kernelspec.display_name).toBe("R");
    expect(nb.metadata.kernelspec.language).toBe("r");
    expect(nb.metadata.language_info.name).toBe("r");
  });

  it("serializes a stream + execute_result cell", () => {
    const cells: CellRecord[] = [
      {
        source: "x = 41\nx + 1",
        result: {
          cellId: "c1",
          executionId: "e1",
          executionCount: 1,
          status: "done",
          success: true,
          outputs: [
            { outputType: "stream", name: "stdout", text: "hello\n" },
            {
              outputType: "execute_result",
              dataJson: JSON.stringify(normalizeMimebundle({ "text/plain": "42" })),
              executionCount: 1,
            },
          ],
        },
      },
    ];
    const nb = buildNotebook(cells) as any;
    const cell = nb.cells[0];
    expect(cell.cell_type).toBe("code");
    expect(cell.source).toEqual(["x = 41\n", "x + 1"]);
    expect(cell.execution_count).toBe(1);
    expect(cell.outputs[0]).toEqual({
      output_type: "stream",
      name: "stdout",
      text: ["hello\n"],
    });
    expect(cell.outputs[1].output_type).toBe("execute_result");
    // execute_result MUST carry execution_count (nbformat requirement).
    expect(cell.outputs[1].execution_count).toBe(1);
    // mimebundle is denormalized back to raw form.
    expect(cell.outputs[1].data["text/plain"]).toBe("42");
  });

  it("serializes an error output", () => {
    const cells: CellRecord[] = [
      {
        source: "1/0",
        result: {
          cellId: "c2",
          executionId: "e2",
          executionCount: 2,
          status: "error",
          success: false,
          outputs: [
            {
              outputType: "error",
              ename: "ZeroDivisionError",
              evalue: "division by zero",
              traceback: ["Traceback..."],
            },
          ],
        },
      },
    ];
    const nb = buildNotebook(cells) as any;
    const out = nb.cells[0].outputs[0];
    expect(out.output_type).toBe("error");
    expect(out.ename).toBe("ZeroDivisionError");
    expect(out.traceback).toEqual(["Traceback..."]);
  });

  it("round-trips a raster image to raw base64", () => {
    const cells: CellRecord[] = [
      {
        source: "plt.show()",
        result: {
          cellId: "c3",
          executionId: "e3",
          status: "done",
          success: true,
          outputs: [
            {
              outputType: "display_data",
              dataJson: JSON.stringify(normalizeMimebundle({ "image/png": "iVBORw0=" })),
            },
          ],
        },
      },
    ];
    const nb = buildNotebook(cells) as any;
    expect(nb.cells[0].outputs[0].data["image/png"]).toBe("iVBORw0=");
  });
});

describe("parseNotebook (resume-from-file)", () => {
  it("parses code cells preserving sources, ids and outputs", () => {
    const model = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {
        kernelspec: { name: "python3", display_name: "Python 3", language: "python" },
        language_info: { name: "python" },
      },
      cells: [
        {
          cell_type: "code",
          id: "file-a",
          metadata: {},
          source: ["import pandas\n", "df = pd.DataFrame()"],
          execution_count: 3,
          outputs: [
            { output_type: "stream", name: "stdout", text: ["done\n"] },
            {
              output_type: "execute_result",
              data: { "text/plain": "3" },
              execution_count: 3,
              metadata: {},
            },
          ],
        },
        {
          cell_type: "markdown",
          id: "file-b",
          metadata: {},
          source: ["## Notes"],
        },
      ],
    } as any;
    const { meta, slots } = parseNotebook(model);
    expect(meta?.kernelName).toBe("python3");
    expect(meta?.language).toBe("python");
    expect(slots).toHaveLength(2);
    const code = slots[0];
    expect(code.kind).toBe("code");
    if (code.kind === "code") {
      expect(code.cellId).toBe("file-a");
      expect(code.source).toBe("import pandas\ndf = pd.DataFrame()");
      expect(code.restored).toBe(true);
      expect(code.result.executionCount).toBe(3);
      expect(code.result.outputs?.[1]).toMatchObject({ outputType: "execute_result" });
    }
    expect(slots[1]).toMatchObject({ kind: "other" });
  });

  it("round-trips: build → parse → build keeps non-code cells verbatim", () => {
    const model = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: "ir", display_name: "R", language: "r" }, language_info: { name: "r" } },
      cells: [
        { cell_type: "markdown", id: "m1", metadata: {}, source: ["# title"] },
        {
          cell_type: "code",
          id: "c1",
          metadata: { tags: ["keep-me"] },
          source: ["x <- 1"],
          execution_count: 7,
          outputs: [{ output_type: "stream", name: "stdout", text: ["[1] 1"] }],
        },
      ],
    } as any;
    const { slots } = parseNotebook(model);
    const rebuilt = buildNotebookFromSlots(slots, { kernelName: "ir", displayName: "R", language: "r" }) as any;
    // markdown cell preserved byte-for-byte
    expect(rebuilt.cells[0]).toEqual(model.cells[0]);
    // restored code cell kept verbatim (metadata + outputs + count untouched)
    expect(rebuilt.cells[1]).toEqual(model.cells[1]);
    expect(rebuilt.metadata.kernelspec.name).toBe("ir");
  });

  it("a re-run cell serializes from the fresh record (keeps its cell id)", () => {
    const model = {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: { kernelspec: { name: "python3", display_name: "Python 3", language: "python" } },
      cells: [
        {
          cell_type: "code",
          id: "orig-id",
          metadata: {},
          source: ["x = 1"],
          execution_count: 1,
          outputs: [{ output_type: "stream", name: "stdout", text: ["old"] }],
        },
      ],
    } as any;
    const { slots } = parseNotebook(model);
    const code = slots[0] as Extract<typeof slots[number], { kind: "code" }>;
    // simulate an in-place re-run (session.ts does this when a restored cell runs)
    code.restored = false;
    code.raw = undefined;
    code.result = {
      cellId: "orig-id",
      executionId: "exec-1",
      executionCount: 2,
      status: "done",
      success: true,
      outputs: [{ outputType: "stream", name: "stdout", text: "new" }],
    };
    const rebuilt = buildNotebookFromSlots(slots) as any;
    expect(rebuilt.cells).toHaveLength(1);
    expect(rebuilt.cells[0].id).toBe("orig-id");
    expect(rebuilt.cells[0].execution_count).toBe(2);
    expect(rebuilt.cells[0].outputs[0].text).toEqual(["new"]);
  });
});
