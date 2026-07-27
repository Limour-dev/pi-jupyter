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

/** Build a nbformat 4.5 compatible notebook object (pure JSON). */
export function buildNotebook(cells: CellRecord[]): Record<string, unknown> {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: "Python 3", language: "python", name: "python3" },
      language_info: { name: "python" },
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
