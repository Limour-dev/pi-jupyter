/**
 * Known-notebook registry (~/.pi-jupyter/notebooks.json) — a tiny persistent
 * store listing every contents path pi has opened.
 *
 * Purpose: continuity across conversations. A NEW pi conversation starts with
 * an empty session map; `jupyter_list_notebooks(dir=…)` merges this registry with the
 * server's live /api/sessions rows — scoped to one remote contents directory (only
 * direct children of `dir`, never recursing into subdirectories) — so the agent (and
 * the user) can say
 * "continue notebook X" — attaching to X's still-running kernel when one
 * exists, or resuming X's file with a fresh kernel bound to the same path.
 *
 * File shape: `{ "<contents path>": { kernelName, updated, source, localFile? }, ... }`
 * Live state is NEVER stored here — it is read fresh from the server at list
 * time (a stale registry entry whose kernel died just means "file only").
 * The file is created/updated atomically (write tmp + rename), like purposes.json.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type NotebookRecord = {
  /** Last kernel (kernelspec name) used for this notebook. */
  kernelName: string;
  /** ISO timestamp of the last pi touch. */
  updated: string;
  /** Where the canonical file lives: the remote server, or imported from local. */
  source: "remote" | "local";
  /** Local path the file was imported from (source: "local" only). */
  localFile?: string;
};

/** Contents path → record of the notebooks pi has opened. */
export type NotebooksStore = Record<string, NotebookRecord>;

/** Path of the registry file under a home/base directory. */
export function notebooksFilePath(dir: string = homedir()): string {
  return join(dir, ".pi-jupyter", "notebooks.json");
}

/**
 * Load the persisted registry. Missing or corrupt file → `{}` (a corrupt file
 * is treated as empty; the next save overwrites it).
 */
export function loadNotebooks(dir?: string): NotebooksStore {
  try {
    const raw: unknown = JSON.parse(readFileSync(notebooksFilePath(dir), "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const out: NotebooksStore = {};
      for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
        const p = path.trim();
        if (!p) continue;
        const rec = value as Partial<NotebookRecord> | null;
        if (!rec || typeof rec !== "object") continue;
        const kernelName = typeof rec.kernelName === "string" ? rec.kernelName.trim() : "";
        if (!kernelName) continue;
        out[p] = {
          kernelName,
          updated: typeof rec.updated === "string" ? rec.updated : new Date().toISOString(),
          source: rec.source === "local" ? "local" : "remote",
          ...(rec.localFile ? { localFile: String(rec.localFile) } : {}),
        };
      }
      return out;
    }
  } catch {
    /* no file yet / unreadable / not JSON — start empty */
  }
  return {};
}

/** Persist the registry (atomically). Throws on I/O failure — callers surface it. */
export function saveNotebooks(store: NotebooksStore, dir?: string): void {
  const file = notebooksFilePath(dir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf-8");
  renameSync(tmp, file); // atomic replace: a crash can never leave a half-written file
}

/** Merge a record into the store and persist it. Returns the updated store. */
export function touchNotebook(path: string, rec: Omit<NotebookRecord, "updated">, dir?: string): NotebooksStore {
  const store = loadNotebooks(dir);
  store[path] = { ...rec, updated: new Date().toISOString() };
  saveNotebooks(store, dir);
  return store;
}

/** Drop one path from the registry (after its kernel/file is gone) and persist. */
export function forgetNotebook(path: string, dir?: string): NotebooksStore {
  const store = loadNotebooks(dir);
  if (store[path] === undefined) return store;
  delete store[path];
  saveNotebooks(store, dir);
  return store;
}
