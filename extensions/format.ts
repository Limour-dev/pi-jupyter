/**
 * Output formatting: CellResult → pi message content.
 *
 * Ported from nteract's repl.ts; relies on the domain OutputConverter having
 * normalized every mimebundle entry to `{ type, value }`.  Lives outside
 * `repl.ts` so it can be unit-tested without a live ExtensionAPI.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { stripAnsi } from "../src/domain/output";
import type { CellResult } from "../src/domain/types";

export { stripAnsi };

/**
 * Convert a CellResult into pi message content (text + inline images).
 *
 * The text part carries a `cell <id> [n] status` header followed by the
 * concatenated text-ish outputs; raster images are attached as separate
 * ImageContent parts so the model can see them.
 */
export function formatResult(result: CellResult): {
  content: (TextContent | ImageContent)[];
  isError: boolean;
} {
  const outputs = result.outputs ?? [];
  const isError =
    result.status === "error" ||
    result.status === "kernel_error" ||
    result.status === "timeout" ||
    outputs.some((o) => o.outputType === "error");

  const parts: (TextContent | ImageContent)[] = [];
  const header = `cell ${result.cellId} [${result.executionCount ?? "?"}] ${result.status}`;
  const textChunks: string[] = [];

  for (const o of outputs) {
    switch (o.outputType) {
      case "stream": {
        const prefix = o.name === "stderr" ? "[stderr] " : "";
        textChunks.push(prefix + (o.text ?? ""));
        break;
      }
      case "execute_result":
      case "display_data": {
        if (!o.dataJson) break;
        let data: Record<string, { type: string; value: unknown }>;
        try {
          data = JSON.parse(o.dataJson);
        } catch {
          break;
        }
        const hasImage = Object.keys(data).some(
          (m) => m.startsWith("image/") && m !== "image/svg+xml",
        );
        // Text-ish rep for the agent.  Skip generic Figure reprs when we also
        // have an image — the image is more useful.
        const textRep =
          (data["text/llm+plain"]?.value as string | undefined) ??
          (data["text/plain"]?.value as string | undefined);
        if (textRep && !(hasImage && /^<Figure[^>]*>/.test(textRep.trim()))) {
          textChunks.push(String(textRep));
        }
        // Attach raster images inline so the model can see them.
        // Attach raster images inline so the model can see them.  When a
        // bundle carries both png and jpeg it is the same figure twice —
        // keep png only (BUG-5).
        const hasPng = data["image/png"]?.type === "binary";
        for (const [mime, entry] of Object.entries(data)) {
          if (!mime.startsWith("image/")) continue;
          if (mime === "image/svg+xml") continue;
          if (hasPng && mime === "image/jpeg") continue;
          // Dedupe (Jupyter often sends the same image twice).
          const dup = parts.some(
            (p) =>
              p.type === "image" &&
              (p as ImageContent).data === entry.value &&
              (p as ImageContent).mimeType === mime,
          );
          if (dup) continue;
          parts.push({ type: "image", mimeType: mime, data: entry.value } as ImageContent);
        }
        break;
      }
      case "error": {
        const tb = Array.isArray(o.traceback) ? o.traceback.join("\n") : "";
        textChunks.push(tb || `${o.ename ?? "Error"}: ${o.evalue ?? ""}`);
        break;
      }
      default:
        textChunks.push(`[${o.outputType} output]`);
    }
  }

  const body = stripAnsi(textChunks.join("").replace(/\n+$/, ""));
  parts.unshift({
    type: "text",
    text: body ? `${header}\n${body}` : header,
  });
  return { content: parts, isError };
}

/** Lines kept from the START of an over-long REPL output. */
export const MAX_OUTPUT_HEAD_LINES = 50;
/** Lines kept from the END of an over-long REPL output. */
export const MAX_OUTPUT_TAIL_LINES = 100;

/** How much of an over-long output was moved out of the transcript. */
export type OutputCap = {
  text: string;
  /** Number of middle lines dropped from the returned head+tail (0 = untouched). */
  dropped: number;
  /** Where the dropped middle lines were written, when a log was created. */
  logPath?: string;
};

let logSeq = 0;

/** Best-effort dump of the dropped lines; a full /tmp must never break a run. */
function writeOverflowLog(lines: string[]): string | undefined {
  try {
    const dir = join(tmpdir(), "pi-jupyter");
    mkdirSync(dir, { recursive: true });
    const name = `repl-output-${Date.now().toString(36)}-${process.pid}-${logSeq++}.log`;
    const path = join(dir, name);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    return path;
  } catch {
    return undefined;
  }
}

/**
 * Keep the FIRST `headLines` and the LAST `tailLines` of a text block, dropping
 * the middle. When anything is dropped, those middle lines are written to a log
 * file under the system temp dir and the returned text carries a note pointing
 * at it, so the agent can read them on demand instead of paying for them in
 * every context window. Both the head and the tail are kept because a REPL run
 * usually announces what it is doing first and states the result last.
 */
export function capOutputText(
  text: string,
  headLines = MAX_OUTPUT_HEAD_LINES,
  tailLines = MAX_OUTPUT_TAIL_LINES,
): OutputCap {
  const budget = Math.max(0, headLines) + Math.max(0, tailLines);
  if (budget <= 0) return { text, dropped: 0 };
  const lines = text.split("\n");
  if (lines.length <= budget) return { text, dropped: 0 };
  const head = lines.slice(0, headLines);
  const tail = lines.slice(lines.length - tailLines);
  const droppedLines = lines.slice(headLines, lines.length - tailLines);
  const logPath = writeOverflowLog(droppedLines);
  const note = logPath
    ? `…(${droppedLines.length} middle line(s) omitted — full output saved to ${logPath}; read it on demand, e.g. read(path="${logPath}"))`
    : `…(${droppedLines.length} middle line(s) omitted)`;
  return {
    text: [...head, note, ...tail].join("\n"),
    dropped: droppedLines.length,
    ...(logPath ? { logPath } : {}),
  };
}

/** Apply {@link capOutputText} to the text parts of a formatted result, leaving images intact. */
export function capOutputContent(
  content: (TextContent | ImageContent)[],
  headLines = MAX_OUTPUT_HEAD_LINES,
  tailLines = MAX_OUTPUT_TAIL_LINES,
): { content: (TextContent | ImageContent)[]; dropped: number; logPaths: string[] } {
  const logPaths: string[] = [];
  let dropped = 0;
  const capped = content.map((part) => {
    if (part.type !== "text") return part;
    const cap = capOutputText(part.text, headLines, tailLines);
    dropped += cap.dropped;
    if (cap.logPath) logPaths.push(cap.logPath);
    return { type: "text" as const, text: cap.text };
  });
  return { content: capped, dropped, logPaths };
}

