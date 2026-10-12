/**
 * Unit tests: output formatting (CellResult → pi message content).
 * Covers the png+jpeg single-image rule (BUG-5) and ANSI stripping.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  MAX_OUTPUT_HEAD_LINES,
  MAX_OUTPUT_TAIL_LINES,
  capOutputContent,
  capOutputText,
  formatResult,
  stripAnsi,
} from "../../extensions/format";
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

describe("capOutputText — REPL output head+tail limit", () => {
  it("leaves a short output untouched", () => {
    const cap = capOutputText("a\nb\nc", 2, 3);
    expect(cap.dropped).toBe(0);
    expect(cap.text).toBe("a\nb\nc");
    expect(cap.logPath).toBeUndefined();
  });

  it("keeps the head and tail, and logs the dropped middle", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line${i}`);
    const cap = capOutputText(lines.join("\n"), 2, 3);
    expect(cap.dropped).toBe(5);
    expect(cap.text.startsWith("line0\nline1\n…(5 middle line(s) omitted")).toBe(true);
    expect(cap.text.endsWith("line7\nline8\nline9")).toBe(true);
    expect(cap.logPath).toBeTruthy();
    const logged = readFileSync(cap.logPath as string, "utf8");
    expect(logged).toBe("line2\nline3\nline4\nline5\nline6\n");
  });

  it("defaults to first 50 + last 100 lines", () => {
    const text = Array.from({ length: 300 }, (_, i) => `l${i}`).join("\n");
    const cap = capOutputText(text);
    expect(MAX_OUTPUT_HEAD_LINES).toBe(50);
    expect(MAX_OUTPUT_TAIL_LINES).toBe(100);
    expect(cap.dropped).toBe(150);
    const out = cap.text.split("\n");
    expect(out).toHaveLength(151); // 50 head + 1 note + 100 tail
    expect(out[0]).toBe("l0");
    expect(out[49]).toBe("l49");
    expect(out[50]).toContain("150 middle line(s) omitted");
    expect(out[51]).toBe("l200");
    expect(out[150]).toBe("l299");
  });
});

describe("capOutputContent — images survive the cap", () => {
  it("caps text and keeps image parts", () => {
    const text = Array.from({ length: 5 }, (_, i) => `l${i}`).join("\n");
    const { content, dropped, logPaths } = capOutputContent(
      [
        { type: "text", text },
        { type: "image", mimeType: "image/png", data: "AAAA" },
      ],
      1,
      2,
    );
    expect(dropped).toBe(2);
    expect(logPaths).toHaveLength(1);
    expect(content.filter((c) => c.type === "image")).toHaveLength(1);
    const body = (content[0] as { text: string }).text.split("\n");
    expect(body[0]).toBe("l0");
    expect(body[1]).toContain("2 middle line(s) omitted");
    expect(body.slice(2)).toEqual(["l3", "l4"]);
  });
});
