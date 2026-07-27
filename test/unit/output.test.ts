/**
 * Unit tests: mimebundle normalization + image dedupe (pure domain logic).
 * No Jupyter Server, no network — runs offline.
 */
import { describe, expect, it } from "vitest";
import {
  dedupeImages,
  denormalizeMimebundle,
  isRasterImage,
  normalizeMimebundle,
} from "../../src/domain/output";
import type { JsOutput } from "../../src/domain/types";

describe("isRasterImage", () => {
  it("accepts raster image mimes", () => {
    expect(isRasterImage("image/png")).toBe(true);
    expect(isRasterImage("image/jpeg")).toBe(true);
  });
  it("rejects svg (text, not raster)", () => {
    expect(isRasterImage("image/svg+xml")).toBe(false);
  });
  it("rejects non-image mimes", () => {
    expect(isRasterImage("text/plain")).toBe(false);
    expect(isRasterImage("application/json")).toBe(false);
  });
});

describe("normalizeMimebundle", () => {
  it("wraps raster images as binary", () => {
    const out = normalizeMimebundle({ "image/png": "iVBORw0KGgo=" });
    expect(out["image/png"]).toEqual({ type: "binary", value: "iVBORw0KGgo=" });
  });

  it("wraps plain text as text", () => {
    const out = normalizeMimebundle({ "text/plain": "<Figure size 640x480>" });
    expect(out["text/plain"]).toEqual({ type: "text", value: "<Figure size 640x480>" });
  });

  it("stringifies structured payloads (application/json)", () => {
    const out = normalizeMimebundle({ "application/json": { a: 1 } });
    expect(out["application/json"]).toEqual({ type: "text", value: '{"a":1}' });
  });

  it("returns empty object for null/undefined", () => {
    expect(normalizeMimebundle(null)).toEqual({});
    expect(normalizeMimebundle(undefined)).toEqual({});
  });

  it("coerces non-string raster values to string", () => {
    const out = normalizeMimebundle({ "image/png": 42 });
    expect(out["image/png"]).toEqual({ type: "binary", value: "42" });
  });
});

describe("denormalizeMimebundle (round-trip)", () => {
  it("reverses normalization for images", () => {
    const raw = { "image/png": "AAAA", "text/plain": "hi" };
    const normalized = JSON.stringify(normalizeMimebundle(raw));
    expect(denormalizeMimebundle(normalized)).toEqual(raw);
  });

  it("parses application/json back to an object", () => {
    const normalized = JSON.stringify({
      "application/json": { type: "text", value: '{"x":1}' },
    });
    expect(denormalizeMimebundle(normalized)).toEqual({ "application/json": { x: 1 } });
  });

  it("returns empty object for undefined / malformed JSON", () => {
    expect(denormalizeMimebundle(undefined)).toEqual({});
    expect(denormalizeMimebundle("{not json")).toEqual({});
  });
});

describe("dedupeImages", () => {
  const img = (id: string, outputType: JsOutput["outputType"]): JsOutput => ({
    outputType,
    dataJson: JSON.stringify({ "image/png": { type: "binary", value: id } }),
  });

  it("removes a duplicate image across execute_result + display_data", () => {
    const outputs: JsOutput[] = [img("SAME", "execute_result"), img("SAME", "display_data")];
    const result = dedupeImages(outputs);
    expect(result).toHaveLength(1);
    expect(result[0].outputType).toBe("execute_result");
  });

  it("keeps distinct images", () => {
    const outputs: JsOutput[] = [img("AAA", "display_data"), img("BBB", "display_data")];
    expect(dedupeImages(outputs)).toHaveLength(2);
  });

  it("never filters non-image outputs", () => {
    const outputs: JsOutput[] = [
      { outputType: "stream", name: "stdout", text: "a" },
      { outputType: "stream", name: "stdout", text: "a" },
      { outputType: "error", ename: "E", evalue: "v" },
    ];
    expect(dedupeImages(outputs)).toHaveLength(3);
  });

  it("survives malformed dataJson", () => {
    const outputs: JsOutput[] = [
      { outputType: "execute_result", dataJson: "{bad" },
      { outputType: "execute_result", dataJson: "{bad" },
    ];
    expect(dedupeImages(outputs)).toHaveLength(2);
  });
});
