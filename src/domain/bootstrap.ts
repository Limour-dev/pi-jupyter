/**
 * Bootstrap — kernel-side initialization code (sent as strings, not run here).
 *
 * C3 note: the Python below is *data we send to the kernel to execute*, not
 * our implementation language.  Our source remains 100% TypeScript.
 */

/** Idempotent inline-backend activation so figures emit as image/png base64. */
export const BOOTSTRAP_CODE = `
import warnings as _w
try:
    get_ipython().run_line_magic("matplotlib", "inline")
except Exception:
    pass
try:
    from matplotlib_inline.backend_inline import InlineBackend
    InlineBackend.instance().figure_format = "png"
except Exception:
    try:
        from matplotlib_inline.backend_inline import set_matplotlib_formats
        with _w.catch_warnings():
            _w.simplefilter("ignore", DeprecationWarning)
            set_matplotlib_formats("png")
    except Exception:
        pass
`.trim();

/** Python probe that prints `{"missing": [...]}` for common packages. */
export const MISSING_PACKAGES_PROBE = `
import json as _json
_missing = []
for _m in ("matplotlib", "pandas", "numpy"):
    try:
        __import__(_m)
    except ImportError:
        _missing.append(_m)
print(_json.dumps({"missing": _missing}))
`.trim();

/**
 * Parse the probe's stdout into warning strings.
 *
 * Pure: takes the collected stdout text, returns human-readable warnings.
 * Tolerates noise — only the last JSON line matters.
 */
export function parseMissingPackages(stdoutText: string): string[] {
  const lines = stdoutText.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as { missing?: string[] };
      if (Array.isArray(parsed.missing) && parsed.missing.length > 0) {
        return [
          `missing packages in remote kernel: ${parsed.missing.join(", ")} — use jupyter_add_dependencies`,
        ];
      }
      return [];
    } catch {
      // not JSON — keep scanning upwards
    }
  }
  return [];
}
