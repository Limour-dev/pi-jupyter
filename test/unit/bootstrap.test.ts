/**
 * Unit tests: bootstrap code constants + missing-package parser.
 */
import { describe, expect, it } from "vitest";
import {
  BOOTSTRAP_CODE,
  MISSING_PACKAGES_PROBE,
  parseMissingPackages,
} from "../../src/domain/bootstrap";

describe("bootstrap constants", () => {
  it("bootstrap activates matplotlib inline", () => {
    expect(BOOTSTRAP_CODE).toContain("matplotlib");
    expect(BOOTSTRAP_CODE).toContain("inline");
  });
  it("probe imports json and prints missing list", () => {
    expect(MISSING_PACKAGES_PROBE).toContain("import json");
    expect(MISSING_PACKAGES_PROBE).toContain('"missing"');
  });
});

describe("parseMissingPackages", () => {
  it("parses the last JSON line", () => {
    expect(parseMissingPackages('{"missing": ["matplotlib", "pandas"]}')).toEqual([
      "missing packages in remote kernel: matplotlib, pandas — use python_add_dependencies",
    ]);
  });

  it("ignores noise before the JSON line", () => {
    const stdout = "Some warning\nmore noise\n" + '{"missing": ["numpy"]}';
    expect(parseMissingPackages(stdout)).toHaveLength(1);
    expect(parseMissingPackages(stdout)[0]).toContain("numpy");
  });

  it("returns [] when nothing is missing", () => {
    expect(parseMissingPackages('{"missing": []}')).toEqual([]);
  });

  it("returns [] when there is no JSON at all", () => {
    expect(parseMissingPackages("just text\nno json here")).toEqual([]);
  });

  it("scans upward past trailing non-JSON lines", () => {
    const stdout = '{"missing": ["pandas"]}\ntrailing log line';
    expect(parseMissingPackages(stdout)).toHaveLength(1);
    expect(parseMissingPackages(stdout)[0]).toContain("pandas");
  });
});
