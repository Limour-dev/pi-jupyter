/**
 * Unit tests: the pure notebook-listing merge (server contents + live sessions
 * + the opened-notebooks registry). Offline — no server, no fs.
 *
 * These lock in the two v3 listing bugs the merge fixes:
 *   - a real `.ipynb` that pi never opened must be VISIBLE (server truth);
 *   - a registry entry whose file no longer exists must be dropped as STALE.
 */
import { describe, expect, it } from "vitest";
import {
  isDescendant,
  isDirectChild,
  mergeNotebookRows,
  type MergeListingInput,
} from "../../src/domain/listing";
import type { ContentsEntry } from "../../src/domain/types";

function nb(path: string): ContentsEntry {
  return { name: path.split("/").pop() ?? path, path, type: "notebook" };
}

function input(overrides: Partial<MergeListingInput> = {}): MergeListingInput {
  return {
    dir: ".",
    serverNotebooks: [],
    serverListed: true,
    liveSessions: [],
    registry: {},
    openPaths: [],
    ...overrides,
  };
}

describe("isDirectChild", () => {
  it("matches only the immediate parent", () => {
    expect(isDirectChild("notes/a.ipynb", "notes")).toBe(true);
    expect(isDirectChild("notes/sub/a.ipynb", "notes")).toBe(false);
    expect(isDirectChild("other/a.ipynb", "notes")).toBe(false);
  });

  it("normalizes ./ and trailing slashes", () => {
    expect(isDirectChild("./notes/a.ipynb", "notes/")).toBe(true);
    expect(isDirectChild("/notes/a.ipynb", "/notes")).toBe(true);
  });

  it('treats "." as the root (top-level notebooks only)', () => {
    expect(isDirectChild("a.ipynb", ".")).toBe(true);
    expect(isDirectChild("notes/a.ipynb", ".")).toBe(false);
  });
});

describe("isDescendant", () => {
  it("matches at any depth below the dir", () => {
    expect(isDescendant("notes/a.ipynb", "notes")).toBe(true);
    expect(isDescendant("notes/sub/deep/a.ipynb", "notes")).toBe(true);
    expect(isDescendant("notes", "notes")).toBe(false); // the dir itself is not inside itself
    expect(isDescendant("notesx/a.ipynb", "notes")).toBe(false);
  });

  it('"." matches everything', () => {
    expect(isDescendant("a.ipynb", ".")).toBe(true);
    expect(isDescendant("x/y/z.ipynb", ".")).toBe(true);
  });
});

describe("mergeNotebookRows", () => {
  it("shows a server file even when the registry never saw it", () => {
    const { rows } = mergeNotebookRows(input({ dir: "mace", serverNotebooks: [nb("mace/new.ipynb")] }));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ path: "mace/new.ipynb", exists: true, kernel: "?" });
  });

  it("drops a registry ghost (no server file, no live kernel) and reports it stale", () => {
    const { rows, stale } = mergeNotebookRows(
      input({
        dir: "mace",
        serverNotebooks: [nb("mace/real.ipynb")],
        registry: {
          "mace/real.ipynb": { kernelName: "python3", updated: "2026-09-06", source: "remote" },
          "mace/ghost.ipynb": { kernelName: "ir", updated: "2026-09-06", source: "remote" },
        },
      }),
    );
    expect(rows.map((r) => r.path)).toEqual(["mace/real.ipynb"]);
    expect(stale).toEqual(["mace/ghost.ipynb"]);
    expect(rows[0].kernel).toBe("python3"); // registry kernelspec kept for a real file
  });

  it("keeps a registry entry when the server listing was unavailable", () => {
    const { rows, stale } = mergeNotebookRows(
      input({
        dir: "mace",
        serverListed: false,
        registry: { "mace/x.ipynb": { kernelName: "python3", updated: "2026-01-01", source: "remote" } },
      }),
    );
    expect(rows.map((r) => r.path)).toEqual(["mace/x.ipynb"]);
    expect(rows[0].exists).toBe(false); // unverified, but not dropped
    expect(stale).toEqual([]);
  });

  it("merges live kernels and open sessions over the registry", () => {
    const { rows } = mergeNotebookRows(
      input({
        dir: "mace",
        serverNotebooks: [nb("mace/a.ipynb")],
        registry: {
          "mace/a.ipynb": { kernelName: "python3", updated: "2026-01-01", source: "remote" },
        },
        liveSessions: [{ path: "mace/a.ipynb", kernelName: "ir" }],
        openPaths: ["mace/a.ipynb"],
      }),
    );
    expect(rows[0]).toMatchObject({ path: "mace/a.ipynb", live: true, open: true, kernel: "ir" });
  });

  it("scopes to direct children by default and to the subtree with recursive", () => {
    const all = [nb("a.ipynb"), nb("sub/b.ipynb"), nb("sub/deep/c.ipynb")];
    expect(mergeNotebookRows(input({ serverNotebooks: all })).rows.map((r) => r.path)).toEqual([
      "a.ipynb",
    ]);
    expect(
      mergeNotebookRows(input({ serverNotebooks: all, recursive: true })).rows.map((r) => r.path),
    ).toEqual(["a.ipynb", "sub/b.ipynb", "sub/deep/c.ipynb"]);
  });

  it("filters by a case-insensitive path substring", () => {
    const { rows } = mergeNotebookRows(
      input({
        recursive: true,
        query: "IMH",
        serverNotebooks: [nb("mace/imh/survival.ipynb"), nb("mace/aha/maxseg.ipynb")],
      }),
    );
    expect(rows.map((r) => r.path)).toEqual(["mace/imh/survival.ipynb"]);
  });

  it("sorts rows by path", () => {
    const { rows } = mergeNotebookRows(
      input({ serverNotebooks: [nb("z.ipynb"), nb("a.ipynb"), nb("m.ipynb")] }),
    );
    expect(rows.map((r) => r.path)).toEqual(["a.ipynb", "m.ipynb", "z.ipynb"]);
  });
});
