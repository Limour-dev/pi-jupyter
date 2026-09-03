/**
 * NotebookSerializer — build an nbformat 4.5 `.ipynb` from cell history, and
 * parse an existing `.ipynb` back into an ordered document of slots.
 *
 * Pure functions: `CellRecord[] → JSON object` in one direction (build), JSON
 * object → slots → JSON object in the other (parse / round-trip).
 *
 * Mimebundle entries arrive normalized (`{ type, value }`); nbformat wants the
 * raw wire format, so we denormalize on the way out and normalize on the way
 * in.  Non-code cells (markdown/raw) of an adopted notebook are preserved
 * VERBATIM as "other" slots, so adopting a notebook never drops its
 * annotations.
 */
import { denormalizeMimebundle, normalizeMimebundle } from "./output";
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
 * Python one (BUG-2).  When a notebook file is adopted, the header recorded in
 * the file itself is the fallback (see `notebookMetaOf`).
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

/** One cell of an adopted/edited notebook document. */
export type NotebookSlot =
  | {
      kind: "code";
      /** Cell id as it appears in the saved notebook (a file id is kept). */
      cellId: string;
      source: string;
      /**
       * Latest execution result. For a cell restored from a file this carries
       * the recorded outputs from the file until the cell is re-run.
       */
      result: CellResult;
      /**
       * True while the cell has NOT yet been executed on the current kernel.
       * A restored cell that is re-run keeps its id and is executed IN PLACE
       * (like JupyterLab), instead of appending a duplicate.
       */
      restored: boolean;
      /**
       * Verbatim nbformat cell when `restored` — preserved untouched on save,
       * so adopted outputs/metadata survive byte-for-byte until re-run.
       */
      raw?: unknown;
    }
  | {
      kind: "other";
      /** Verbatim nbformat cell (markdown/raw) — never touched by pi. */
      raw: unknown;
    };

/** Parsed view of an adopted notebook for a session document. */
export type ParsedNotebook = {
  /** The kernelspec header recorded in the file, when present. */
  meta?: NotebookMeta;
  slots: NotebookSlot[];
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
    metadata: buildMetadata(meta),
    cells: cells.map((entry, idx) => serializeCodeCell(entry, idx)),
  };
}

/** Build a notebook model from a live document of {@link NotebookSlot}s. */
export function buildNotebookFromSlots(
  slots: NotebookSlot[],
  meta: NotebookMeta = DEFAULT_META,
): Record<string, unknown> {
  return {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: buildMetadata(meta),
    cells: slots.map(slotToNbFormatCell),
  };
}

/**
 * Serialize one run-cell record as an nbformat code cell.  Shared by
 * `buildNotebook` (history export) and the document model (appended cells and
 * in-place re-runs).
 */
export function serializeCodeCell(
  entry: CellRecord,
  idx?: number,
): Record<string, unknown> {
  return {
    cell_type: "code",
    id: entry.result.cellId ?? `cell-${idx ?? 0}`,
    metadata: {},
    source: splitLines(entry.source),
    execution_count: entry.result.executionCount ?? null,
    outputs: toNbOutputs(entry.result.outputs ?? []),
  };
}

/** nbformat header object from {@link NotebookMeta}. */
export function buildMetadata(meta: NotebookMeta): Record<string, unknown> {
  return {
    kernelspec: {
      display_name: meta.displayName,
      language: meta.language,
      name: meta.kernelName,
    },
    language_info: { name: meta.language },
  };
}

/**
 * Parse an nbformat model into a document of slots (see {@link NotebookSlot}).
 * Code cells become code slots whose `result` mirrors the outputs recorded in
 * the file; every other cell type is preserved verbatim.  Returns `undefined`
 * `meta` when the file carries no usable kernelspec header.
 */
export function parseNotebook(model: Record<string, unknown> | null | undefined): ParsedNotebook {
  if (!model || typeof model !== "object") return { slots: [] };
  const cells = Array.isArray((model as { cells?: unknown }).cells)
    ? ((model as { cells: unknown[] }).cells)
    : [];
  const slots: NotebookSlot[] = [];
  cells.forEach((raw, idx) => {
    if (!raw || typeof raw !== "object") return;
    const cell = raw as Record<string, unknown>;
    const kind = cell.cell_type === "code" ? "code"
      : cell.cell_type === "markdown" || cell.cell_type === "raw" ? "other"
      : undefined;
    if (kind === "code") {
      const source = joinText(cell.source);
      const cellId =
        typeof cell.id === "string" && cell.id.trim() ? cell.id : `restored-${idx}`;
      slots.push({
        kind: "code",
        cellId,
        source,
        restored: true,
        raw,
        result: {
          cellId,
          executionId: `file-${idx}`,
          executionCount:
            typeof cell.execution_count === "number" && cell.execution_count > 0
              ? cell.execution_count
              : undefined,
          status: "done",
          success: true,
          outputs: outputsFromNb(cell.outputs),
        },
      });
    } else if (kind === "other") {
      slots.push({ kind: "other", raw });
    }
  });
  return { meta: notebookMetaOf(model), slots };
}

/** The kernelspec header recorded in an nbformat model, if usable. */
export function notebookMetaOf(
  model: Record<string, unknown> | null | undefined,
): NotebookMeta | undefined {
  if (!model || typeof model !== "object") return undefined;
  const metadata = (model as { metadata?: unknown }).metadata;
  if (!metadata || typeof metadata !== "object") return undefined;
  const ks = (metadata as { kernelspec?: unknown }).kernelspec;
  if (!ks || typeof ks !== "object") return undefined;
  const spec = ks as { name?: unknown; display_name?: unknown; language?: unknown };
  const name = typeof spec.name === "string" && spec.name.trim() ? spec.name.trim() : undefined;
  if (!name) return undefined;
  return {
    kernelName: name,
    displayName:
      typeof spec.display_name === "string" && spec.display_name.trim()
        ? spec.display_name.trim()
        : name,
    language:
      typeof spec.language === "string" && spec.language.trim()
        ? spec.language.trim().toLowerCase()
        : "python",
  };
}

/** Serialize a document slot back to its nbformat cell. */
function slotToNbFormatCell(slot: NotebookSlot): unknown {
  if (slot.kind === "other") return slot.raw;
  // A restored, never-re-run cell keeps its verbatim file cell — adopted
  // outputs, metadata and cell order survive byte-for-byte.
  if (slot.restored && slot.raw !== undefined) return slot.raw;
  return serializeCodeCell({ source: slot.source, result: slot.result });
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

/** nbformat output objects → normalized JsOutput (mirror of `toNbOutputs`). */
function outputsFromNb(rawOutputs: unknown): JsOutput[] {
  if (!Array.isArray(rawOutputs)) return [];
  const out: JsOutput[] = [];
  for (const raw of rawOutputs) {
    if (!raw || typeof raw !== "object") continue;
    const o = raw as Record<string, unknown>;
    const outputType = String(o.output_type ?? "");
    if (outputType === "stream") {
      out.push({
        outputType: "stream",
        name: typeof o.name === "string" ? o.name : "stdout",
        text: joinText(o.text),
      });
    } else if (outputType === "execute_result") {
      const data = asMimeBundle(o.data);
      out.push({ outputType: "execute_result", dataJson: JSON.stringify(data) });
    } else if (outputType === "display_data" || outputType === "update_display_data") {
      const data = asMimeBundle(o.data);
      out.push({ outputType: "display_data", dataJson: JSON.stringify(data) });
    } else if (outputType === "error") {
      const traceback = Array.isArray(o.traceback)
        ? o.traceback.filter((t): t is string => typeof t === "string")
        : [];
      out.push({
        outputType: "error",
        ename: typeof o.ename === "string" ? o.ename : "Error",
        evalue: typeof o.evalue === "string" ? o.evalue : "",
        traceback,
      });
    }
  }
  return out;
}

/** Normalize a raw nbformat mimebundle to the `{ type, value }` contract. */
function asMimeBundle(data: unknown): ReturnType<typeof normalizeMimebundle> {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return normalizeMimebundle(data as Record<string, unknown>);
  }
  return {};
}

/** nbformat text/source may be a string or an array of lines. */
function joinText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === "string" ? v : String(v))).join("");
  return "";
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
