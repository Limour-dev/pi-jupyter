/**
 * Unit tests: the known-notebook registry (~/.pi-jupyter/notebooks.json).
 * All tests run against a fresh temp directory — the real home is untouched.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  loadNotebooks,
  notebooksFilePath,
  saveNotebooks,
  touchNotebook,
} from "../../src/notebooks";

const dirs: string[] = [];

function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-notebooks-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("notebooks registry", () => {
  it("returns {} when no file exists yet", () => {
    expect(loadNotebooks(freshDir())).toEqual({});
  });

  it("touch then load round-trips a record and stamps updated", () => {
    const dir = freshDir();
    touchNotebook("notes/pi.ipynb", { kernelName: "python3", source: "remote" }, dir);
    const store = loadNotebooks(dir);
    expect(store["notes/pi.ipynb"]).toMatchObject({ kernelName: "python3", source: "remote" });
    expect(store["notes/pi.ipynb"].updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("preserves an imported local_file note", () => {
    const dir = freshDir();
    touchNotebook("scratch.ipynb", { kernelName: "ir", source: "local", localFile: "/tmp/scratch.ipynb" }, dir);
    expect(loadNotebooks(dir)["scratch.ipynb"]).toMatchObject({
      kernelName: "ir",
      source: "local",
      localFile: "/tmp/scratch.ipynb",
    });
  });

  it("creates the .pi-jupyter directory and writes JSON automatically", () => {
    const base = freshDir();
    const home = join(base, "some", "not-yet-created-home");
    saveNotebooks({ "a.ipynb": { kernelName: "python3", updated: new Date().toISOString(), source: "remote" } }, home);
    expect(readFileSync(notebooksFilePath(home), "utf-8")).toContain('"kernelName": "python3"');
  });

  it("notebooksFilePath points at ~/.pi-jupyter/notebooks.json", () => {
    expect(notebooksFilePath("/tmp/home-x")).toBe("/tmp/home-x/.pi-jupyter/notebooks.json");
  });

  it("treats a corrupt file as empty (next save overwrites it)", () => {
    const dir = freshDir();
    const file = notebooksFilePath(dir);
    mkdirSync(join(dir, ".pi-jupyter"), { recursive: true });
    writeFileSync(file, "{ nope !!!", "utf-8");
    expect(loadNotebooks(dir)).toEqual({});
  });

  it("drops records without a kernel name and trims keys", () => {
    const dir = freshDir();
    const file = notebooksFilePath(dir);
    mkdirSync(join(dir, ".pi-jupyter"), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        "  good.ipynb  ": { kernelName: "  python3 ", updated: "2024-01-01", source: "remote" },
        "no-kernel.ipynb": { updated: "2024-01-01", source: "remote" },
        "bad-ipynb": "junk",
      }),
      "utf-8",
    );
    expect(loadNotebooks(dir)).toEqual({
      "good.ipynb": { kernelName: "python3", updated: "2024-01-01", source: "remote" },
    });
  });
});
