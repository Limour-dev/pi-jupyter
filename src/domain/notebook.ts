/**
 * NotebookSerializer — build an nbformat 4.5 `.ipynb` from cell history.
 *
 * Pure function: `CellRecord[] → JSON object`.  Mimebundle entries arrive
 * normalized (`{ type, value }`); nbformat wants the raw wire format, so we
 * denormalize on the way out.
 */
import { denormalizeMimebundle } from "./output";
import type { CellResult, JsOutput } from "./types";

export type CellRecord = {
  source: string;
  result: CellResult;
};

/**
 * Kernel/language metadata for the notebook header.
 *
 * Sourced from the running kernel's kernelspec (see `session.ts`), so a
 * notebook saved from an R kernel declares an R kernelspec — not a hard-coded
 * Python one (BUG-2).
 */
export type NotebookMeta = {
  /** kernelspec name, e.g. "python3" or "ir". */
  kernelName: string;
  /** kernelspec display name, e.g. "Python 3" or "R". */
  displayName: string;
  /** language, e.g. "python" or "r". */
  language: string;
};

const DEFAULT_META: NotebookMeta = {
  kernelName: "python3",
  displayName: "Python 3",
  language: "python",
};

/**
 * Build a nbformat 4.5 compatible notebook object (pure JSON).
 *
 * `meta` supplies the kernelspec / language_info header; it defaults to a
 * Python kernelspec for backwards compatibility, but callers should pass the
 * real kernelspec so the notebook opens with the correct kernel.
 */
export function buildNotebook(
  cells: CellRecord[],
  meta: NotebookMeta = DEFAULT_META,
): Record<string, unknown> {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: {
        display_name: meta.displayName,
        language: meta.language,
        name: meta.kernelName,
      },
      language_info: { name: meta.language },
    },
    cells: cells.map((entry, idx) => ({
      cell_type: "code",
      id: entry.result.cellId ?? `cell-${idx}`,
      metadata: {},
      source: splitLines(entry.source),
      execution_count: entry.result.executionCount ?? null,
      outputs: toNbOutputs(entry.result.outputs ?? []),
    })),
  };
}

// ── internals ───────────────────────────────────────────────────────────────

function toNbOutputs(js: JsOutput[]): unknown[] {
  return js
    .map((o): unknown => {
      switch (o.outputType) {
        case "stream":
          return {
            output_type: "stream",
            name: o.name ?? "stdout",
            text: splitLines(o.text ?? ""),
          };
        case "execute_result":
          return {
            output_type: "execute_result",
            data: denormalizeMimebundle(o.dataJson),
            // nbformat requires execute_result to carry execution_count.
            execution_count: o.executionCount ?? null,
            metadata: {},
          };
        case "display_data":
          return {
            output_type: "display_data",
            data: denormalizeMimebundle(o.dataJson),
            metadata: {},
          };
        case "error":
          return {
            output_type: "error",
            ename: o.ename ?? "Error",
            evalue: o.evalue ?? "",
            traceback: o.traceback ?? [],
          };
        default:
          return null;
      }
    })
    .filter(Boolean);
}

/**
 * nbformat source/text: an array of lines mirroring Python's
 * `str.splitlines(keepends=True)` — every line keeps its trailing `\n` except
 * the last, and a final newline does NOT leave a dangling empty segment.
 */
export function splitLines(s: string): string[] {
  if (s === "") return [""];
  const parts = s.split("\n");
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const isLast = i === parts.length - 1;
    if (isLast) {
      // A trailing "\n" yields an empty final part — already represented by the
      // previous line's "\n", so drop it rather than emit a dangling "".
      if (parts[i] !== "") out.push(parts[i]);
    } else {
      out.push(parts[i] + "\n");
    }
  }
  return out.length ? out : [""];
}
