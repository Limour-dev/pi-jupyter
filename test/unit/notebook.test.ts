/**
 * Unit tests: notebook serializer (nbformat 4.5 structure).
 */
import { describe, expect, it } from "vitest";
import { buildNotebook, splitLines, type CellRecord } from "../../src/domain/notebook";
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
