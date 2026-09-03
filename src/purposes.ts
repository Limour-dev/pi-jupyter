/**
 * Per-kernel purpose notes — a tiny persistent store (~/.pi-jupyter/purposes.json).
 *
 * The agent asks the user once what a NEW kernel (python3 / ir / …) is for and
 * records the answer here via `jupyter_set_kernel_purpose`; later sessions load
 * it so `jupyter_list_kernels` can show each kernel's purpose and the agent can
 * auto-select the right kernel without re-asking.
 *
 * Important: this store only holds the user's EXPLANATION. It never selects a
 * kernel — the agent still decides per call via the `kernel` parameter
 * (see ARCHITECTURE.md "Who decides the kernel?").
 *
 * File shape: `{ "<kernelspec name>": "<purpose string>", ... }`
 * The directory (~/.pi-jupyter) already hosts the connection config.json.
 * The file is created/updated atomically (write tmp + rename).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** kernelspec name → purpose, as explained by the user. */
export type KernelPurposes = Record<string, string>;

/** Path of the purpose-notes file under a home/base directory. */
export function purposesFilePath(dir: string = homedir()): string {
  return join(dir, ".pi-jupyter", "purposes.json");
}

/**
 * Load the persisted purpose notes. Missing or corrupt file → `{}` (a corrupt
 * file is treated as empty; the next save overwrites it).
 */
export function loadPurposes(dir?: string): KernelPurposes {
  try {
    const raw: unknown = JSON.parse(readFileSync(purposesFilePath(dir), "utf-8"));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const out: KernelPurposes = {};
      for (const [name, purpose] of Object.entries(raw as Record<string, unknown>)) {
        const n = name.trim();
        if (typeof purpose === "string" && purpose.trim()) out[n] = purpose.trim();
      }
      return out;
    }
  } catch {
    /* no file yet / unreadable / not JSON — start empty */
  }
  return {};
}

/** Persist the notes (atomically). Throws on I/O failure — callers surface it. */
export function savePurposes(purposes: KernelPurposes, dir?: string): void {
  const file = purposesFilePath(dir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(purposes, null, 2)}\n`, "utf-8");
  renameSync(tmp, file); // atomic replace: a crash can never leave a half-written file
}
