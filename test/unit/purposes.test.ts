/**
 * Unit tests: the per-kernel purpose store (~/.pi-jupyter/purposes.json).
 * All tests run against a fresh temp directory — the real home is untouched.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadPurposes, purposesFilePath, savePurposes } from "../../src/purposes";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-purposes-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("purposes store", () => {
  it("returns {} when no file exists yet", () => {
    expect(loadPurposes(freshDir())).toEqual({});
  });

  it("save then load round-trips", () => {
    const dir = freshDir();
    savePurposes({ python3: "data analysis", ir: "statistics in R" }, dir);
    expect(loadPurposes(dir)).toEqual({ python3: "data analysis", ir: "statistics in R" });
  });

  it("creates the .pi-jupyter directory and writes JSON automatically", () => {
    const base = freshDir();
    const home = join(base, "some", "not-yet-created-home"); // neither the base nor .pi-jupyter exists
    savePurposes({ python3: "x" }, home);
    expect(readFileSync(purposesFilePath(home), "utf-8")).toContain('"python3": "x"');
  });

  it("purposesFilePath points at ~/.pi-jupyter/purposes.json", () => {
    expect(purposesFilePath("/tmp/home-x")).toBe("/tmp/home-x/.pi-jupyter/purposes.json");
  });

  it("treats a corrupt file as empty (next save overwrites it)", () => {
    const dir = freshDir();
    const file = purposesFilePath(dir);
    mkdirSync(join(dir, ".pi-jupyter"), { recursive: true });
    writeFileSync(file, "{ not json !!!", "utf-8");
    expect(loadPurposes(dir)).toEqual({});
  });

  it("keeps only non-empty string values, trimming keys and values", () => {
    const dir = freshDir();
    const file = purposesFilePath(dir);
    mkdirSync(join(dir, ".pi-jupyter"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ "  python3  ": "  wrangling ", ir: "", julia: 42, empty: "   " }),
      "utf-8",
    );
    expect(loadPurposes(dir)).toEqual({ python3: "wrangling" });
  });
});
