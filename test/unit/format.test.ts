/**
 * Unit tests: output formatting (CellResult → pi message content).
 * Covers the png+jpeg single-image rule (BUG-5) and ANSI stripping.
 */
import { describe, expect, it } from "vitest";
import { formatResult, stripAnsi } from "../../extensions/format";
import { normalizeMimebundle } from "../../src/domain/output";
import type { CellResult, JsOutput } from "../../src/domain/types";

function cellWith(outputs: JsOutput[]): CellResult {
  return {
    cellId: "c1",
    executionId: "e1",
    executionCount: 1,
    status: "done",
    success: true,
    outputs,
  };
}

function bundle(data: Record<string, unknown>): JsOutput {
  return { outputType: "display_data", dataJson: JSON.stringify(normalizeMimebundle(data)) };
}

describe("formatResult — image dedupe (BUG-5)", () => {
  it("attaches only png when a bundle carries both png and jpeg", () => {
    const result = formatResult(
      cellWith([bundle({ "image/png": "PNGDATA", "image/jpeg": "JPEGDATA" })]),
    );
    const images = result.content.filter((c) => c.type === "image");
    expect(images).toHaveLength(1);
    expect((images[0] as { mimeType: string }).mimeType).toBe("image/png");
  });

  it("keeps jpeg when no png is present", () => {
    const result = formatResult(cellWith([bundle({ "image/jpeg": "JPEGDATA" })]));
    const images = result.content.filter((c) => c.type === "image");
    expect(images).toHaveLength(1);
    expect((images[0] as { mimeType: string }).mimeType).toBe("image/jpeg");
  });

  it("does not collapse distinct images from separate outputs", () => {
    const result = formatResult(
      cellWith([bundle({ "image/png": "AAA" }), bundle({ "image/png": "BBB" })]),
    );
    expect(result.content.filter((c) => c.type === "image")).toHaveLength(2);
  });

  it("still attaches png once when duplicated identically", () => {
    const result = formatResult(
      cellWith([
        { outputType: "execute_result", dataJson: JSON.stringify(normalizeMimebundle({ "image/png": "SAME" })) },
        { outputType: "display_data", dataJson: JSON.stringify(normalizeMimebundle({ "image/png": "SAME" })) },
      ]),
    );
    expect(result.content.filter((c) => c.type === "image")).toHaveLength(1);
  });
});

describe("formatResult — text handling", () => {
  it("marks error status as isError", () => {
    const result = formatResult({
      cellId: "c",
      executionId: "e",
      status: "error",
      success: false,
      outputs: [{ outputType: "error", ename: "E", evalue: "boom" }],
    });
    expect(result.isError).toBe(true);
  });

  it("prefixes stderr streams", () => {
    const result = formatResult(
      cellWith([{ outputType: "stream", name: "stderr", text: "warn" }]),
    );
    const text = result.content.find((c) => c.type === "text") as { text: string };
    expect(text.text).toContain("[stderr] warn");
  });
});

describe("stripAnsi", () => {
  it("removes ANSI color codes", () => {
    expect(stripAnsi(`${String.fromCharCode(27)}[31mred${String.fromCharCode(27)}[0m`)).toBe(
      "red",
    );
  });
});
