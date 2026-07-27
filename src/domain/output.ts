/**
 * Mimebundle normalization — pure functions, zero dependencies.
 *
 * Jupyter's wire format carries *raw* mimebundles:
 *
 *     { "image/png": "<base64>", "text/plain": "<Figure …>" }
 *
 * Both the renderer (pi message content) and the notebook serializer expect
 * every entry shaped `{ type, value }`:
 *
 *     { "image/png": { type: "binary", value: "<base64>" } }
 *
 * `normalize` adapts raw → normalized; `denormalize` reverses it for .ipynb
 * export.  `dedupeImages` collapses the duplicate figure Jupyter emits as both
 * an execute_result and a display_data.
 */
import type { JsOutput, NormalizedMimebundle } from "./types";

/** Adapt a raw Jupyter mimebundle to the `{ type, value }` contract. */
export function normalizeMimebundle(
  data: Record<string, unknown> | undefined | null,
): NormalizedMimebundle {
  const out: NormalizedMimebundle = {};
  if (!data) return out;
  for (const [mime, raw] of Object.entries(data)) {
    if (isRasterImage(mime)) {
      out[mime] = { type: "binary", value: typeof raw === "string" ? raw : String(raw) };
    } else if (typeof raw === "string") {
      out[mime] = { type: "text", value: raw };
    } else {
      // application/json or other structured payloads → stringify.
      out[mime] = { type: "text", value: JSON.stringify(raw) };
    }
  }
  return out;
}

/** Reverse {@link normalizeMimebundle} back to a raw Jupyter mimebundle. */
export function denormalizeMimebundle(dataJson: string | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!dataJson) return out;
  let data: NormalizedMimebundle;
  try {
    data = JSON.parse(dataJson) as NormalizedMimebundle;
  } catch {
    return out;
  }
  for (const [mime, entry] of Object.entries(data)) {
    if (entry?.type === "binary") {
      out[mime] = entry.value; // raw base64 string
    } else if (mime === "application/json") {
      try {
        out[mime] = JSON.parse(entry.value);
      } catch {
        out[mime] = entry.value;
      }
    } else {
      out[mime] = entry.value;
    }
  }
  return out;
}

/**
 * Collapse duplicate raster images.
 *
 * Jupyter frequently emits the same figure as both an execute_result and a
 * display_data.  The renderer also dedupes, but doing it here keeps redundant
 * base64 out of the model context.
 */
export function dedupeImages(outputs: JsOutput[]): JsOutput[] {
  const seen = new Set<string>();
  return outputs.filter((o) => {
    if (o.outputType !== "execute_result" && o.outputType !== "display_data") return true;
    try {
      const data = JSON.parse(o.dataJson ?? "{}") as NormalizedMimebundle;
      const imgKeys = Object.keys(data).filter(isRasterImage);
      if (imgKeys.length === 0) return true;
      const fingerprint = imgKeys
        .map((k) => `${k}:${(data[k]?.value ?? "").slice(0, 128)}`)
        .join("|");
      if (seen.has(fingerprint)) return false;
      seen.add(fingerprint);
      return true;
    } catch {
      return true;
    }
  });
}

/** True for raster image MIME types (svg is text, not raster). */
export function isRasterImage(mime: string): boolean {
  return mime.startsWith("image/") && mime !== "image/svg+xml";
}
