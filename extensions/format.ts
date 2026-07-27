/**
 * Output formatting: CellResult → pi message content.
 *
 * Ported from nteract's repl.ts; relies on the domain OutputConverter having
 * normalized every mimebundle entry to `{ type, value }`.  Lives outside
 * `repl.ts` so it can be unit-tested without a live ExtensionAPI.
 */
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { CellResult } from "../src/domain/types";

/** Strip ANSI escape sequences (tracebacks carry color codes). */
export function stripAnsi(s: string): string {
  const esc = String.fromCharCode(27);
  return s.replace(new RegExp(`${esc}\\[[0-9;]*[A-Za-z]`, "g"), "");
}

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
        for (const [mime, entry] of Object.entries(data)) {
          if (!mime.startsWith("image/")) continue;
          if (mime === "image/svg+xml") continue;
          if (entry?.type !== "binary" || typeof entry.value !== "string") continue;
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
