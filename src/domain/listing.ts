/**
 * Pure listing logic for `jupyter_list_notebooks`.
 *
 * Three sources are merged into one truthful view of a remote directory:
 *
 *   1. the SERVER's contents listing — the files that actually exist
 *      (this is what makes an unopened `.ipynb` visible, and what proves a
 *      registry entry is a ghost);
 *   2. the LIVE `/api/sessions` rows — kernels still running somewhere;
 *   3. the `~/.pi-jupyter/notebooks.json` registry — pi's memory of what it
 *      opened before.
 *
 * The registry is only a HINT: a path there that neither exists on the server
 * nor has a live kernel is reported as `stale` and dropped from the listing
 * (the v3 bug where a deleted file kept appearing, and a real file that pi had
 * never opened was invisible).
 *
 * Everything here is pure — no fs, no network — so the merge is unit-tested
 * offline.
 */
import type { ContentsEntry } from "./types";

/** One registry row (`~/.pi-jupyter/notebooks.json`), structurally. */
export type NotebookRegistryEntry = {
  kernelName: string;
  updated: string;
  source: "remote" | "local";
  localFile?: string;
};

/** A live session row (`GET /api/sessions`), reduced to what the listing needs. */
export type LiveSessionEntry = {
  path: string;
  kernelName: string;
};

/** One merged listing row. */
export type NotebookRow = {
  path: string;
  /** Kernel serving it (live kernel, recorded kernelspec, or "?" when unknown). */
  kernel: string;
  /** A live kernel is bound to the path — opening attaches, variables kept. */
  live: boolean;
  /** The notebook is open in THIS pi conversation. */
  open: boolean;
  source: "remote" | "local";
  localFile?: string;
  /** ISO timestamp of the last pi touch (registry). */
  updated: string;
  /** The server listing contains this path (the file exists). */
  exists: boolean;
};

export type MergeListingInput = {
  /** Remote contents directory the listing is scoped to ("." = server root). */
  dir: string;
  /** Include every descendant of `dir`, not just its direct children. */
  recursive?: boolean;
  /** Case-insensitive substring filter applied to the full contents path. */
  query?: string;
  /** Notebook entries from the server listing (type === "notebook"). */
  serverNotebooks: ContentsEntry[];
  /** Whether the server answered the listing at all (false → "dir missing"/error). */
  serverListed: boolean;
  liveSessions: LiveSessionEntry[];
  registry: Record<string, NotebookRegistryEntry>;
  /** Paths open in this conversation (their kernels are running by definition). */
  openPaths: string[];
};

export type MergeListingResult = {
  rows: NotebookRow[];
  /** Registry paths in scope that no longer exist on the server (ghosts). */
  stale: string[];
};

/** Normalize a path into non-empty, non-"." segments. */
function segments(p: string): string[] {
  return p
    .trim()
    .replace(/\\/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter((s) => s !== "" && s !== ".");
}

/**
 * Does a remote contents path sit DIRECTLY inside a directory — its parent is
 * exactly that directory, never deeper? `jupyter_list_notebooks(dir=…)` scopes
 * its listing with this predicate: "the notebooks in notes/" shows notes/a.ipynb
 * but never notes/sub/a.ipynb. Matching happens in remote-contents coordinates;
 * each side is normalized first ("./" and leading/trailing "/" stripped, so
 * "notes/" ≡ "notes" and "./notes/a.ipynb" ≡ "notes/a.ipynb"). The server root
 * is written "." and matches only top-level notebooks.
 */
export function isDirectChild(contentsPath: string, dir: string): boolean {
  const fileSegs = segments(contentsPath);
  const dirSegs = segments(dir);
  if (dirSegs.length === 0) return fileSegs.length === 1;
  if (fileSegs.length !== dirSegs.length + 1) return false;
  return dirSegs.every((s, i) => fileSegs[i] === s);
}

/**
 * Does a remote contents path sit anywhere INSIDE a directory (its descendant,
 * at any depth)? The `recursive` listing uses this. `.` matches every path.
 */
export function isDescendant(contentsPath: string, dir: string): boolean {
  const fileSegs = segments(contentsPath);
  const dirSegs = segments(dir);
  if (dirSegs.length === 0) return fileSegs.length >= 1;
  if (fileSegs.length <= dirSegs.length) return false;
  return dirSegs.every((s, i) => fileSegs[i] === s);
}

/**
 * Merge the server listing, live sessions and the registry into the rows the
 * agent sees. See the file header for the rules; `stale` names the registry
 * ghosts that were dropped.
 */
export function mergeNotebookRows(input: MergeListingInput): MergeListingResult {
  const {
    dir,
    recursive = false,
    query,
    serverNotebooks,
    serverListed,
    liveSessions,
    registry,
    openPaths,
  } = input;
  const q = query?.trim().toLowerCase() ?? "";
  const inScope = (path: string): boolean => {
    if (recursive ? !isDescendant(path, dir) : !isDirectChild(path, dir)) return false;
    if (q && !path.toLowerCase().includes(q)) return false;
    return true;
  };

  const openSet = new Set(openPaths);
  const serverPaths = new Set<string>();
  const map = new Map<string, NotebookRow>();

  const ensure = (path: string): NotebookRow => {
    let row = map.get(path);
    if (!row) {
      const rec = registry[path];
      row = {
        path,
        kernel: rec?.kernelName ?? "?",
        live: false,
        open: openSet.has(path),
        source: rec?.source ?? "remote",
        ...(rec?.localFile ? { localFile: rec.localFile } : {}),
        updated: rec?.updated ?? "",
        exists: false,
      };
      map.set(path, row);
    }
    return row;
  };

  for (const entry of serverNotebooks) {
    if (!inScope(entry.path)) continue;
    ensure(entry.path).exists = true;
    serverPaths.add(entry.path);
  }
  for (const live of liveSessions) {
    if (!inScope(live.path)) continue;
    const row = ensure(live.path);
    row.live = true;
    row.kernel = live.kernelName || row.kernel;
  }
  for (const path of openPaths) {
    if (!inScope(path)) continue;
    const row = ensure(path);
    row.open = true;
    row.live = true; // a session open in this conversation has a running kernel
  }

  const stale: string[] = [];
  for (const path of Object.keys(registry)) {
    if (!inScope(path) || map.has(path)) continue;
    if (serverListed && !serverPaths.has(path)) {
      stale.push(path); // registry ghost: no file, no kernel — drop it
      continue;
    }
    // The server listing was unavailable (missing dir / error): keep the
    // registry hint, flagged as unverified by `exists: false`.
    ensure(path);
  }

  const rows = [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
  return { rows, stale };
}
