/**
 * DependencyManager — hot-install packages into the running kernel.
 *
 * The install command is *language-aware* because `%pip` is an IPython-only
 * magic:
 *
 *   python → `%pip install --quiet <p>`   (IPython built-in; installs into the
 *                                           current kernel's env, never system)
 *   r      → one `install.packages(<pkg>)` per package, each wrapped in
 *            tryCatch with warn = 2, then a `requireNamespace` verification.
 *            Per-package isolation means ONE unavailable CRAN name can no
 *            longer abort the whole batch via getDependencies() (issue
 *            "poisoned deps set", Option 3); the loadable packages still go
 *            in. Each run prints machine-readable PI_INSTALL_* markers so the
 *            session can commit exactly the packages that installed (Option 1).
 *   other  → unsupported; we refuse rather than emit code that cannot work.
 *
 * The install log streams back as normal stdout; the PI_INSTALL_* markers are
 * parsed by `parseInstallOutput` (see below / session.ts runInstall()).
 */

/** Machine-readable marker: space-separated base names that ARE loadable. */
export const INSTALL_OK_MARKER = "PI_INSTALL_OK";
/** Machine-readable marker: space-separated base names that failed. */
export const INSTALL_FAILED_MARKER = "PI_INSTALL_FAILED";

/**
 * Build the install code for a set of package specs. Pure and deterministic.
 *
 * @param packages  Package specs (pip-style for python, CRAN names for R).
 * @param language  Kernel language (from its kernelspec); defaults to python.
 * @throws if the language has no supported hot-install path.
 */
export function buildInstallCode(packages: string[], language = "python"): string {
  const uniq = [...new Set(packages.map((p) => p.trim()).filter(Boolean))];
  if (uniq.length === 0) return "";
  const lang = language.toLowerCase();
  if (lang === "python") {
    return uniq.map((p) => `%pip install --quiet ${p}`).join("\n");
  }
  if (lang === "r") {
    return buildRInstallCode(uniq);
  }
  throw new Error(`[pi-jupyter] unsupported language for hot-install: ${language}`);
}

/**
 * Per-package R install (issue "poisoned deps set", Option 3).
 *
 * The old form emitted a single `install.packages(c("a", "b"), …)` with
 * warn = 2: when "a" was unavailable, getDependencies() raised BEFORE
 * anything installed, so a valid "b" in the same batch never went in. Here
 * each package installs in its own tryCatch (warn = 2 promotes failure
 * warnings to errors so they are caught), the loop never aborts, and a final
 * requireNamespace() check decides what is actually loadable. Machine-readable
 * PI_INSTALL_* markers report the partition back to the session so it commits
 * only the packages that installed (Option 1) and keeps the loadable ones even
 * when the call as a whole failed.
 */
function buildRInstallCode(uniq: string[]): string {
  const vector = uniq.map((p) => rString(p)).join(", ");
  return (
    "local({\n" +
    "  old <- options(warn = 2); on.exit(options(old));\n" +
    `  pkgs <- c(${vector});\n` +
    "  ok <- character(0); failed <- character(0);\n" +
    "  sanitize <- function(x) gsub('[^A-Za-z0-9._]', '', as.character(x));\n" +
    "  for (p in pkgs) {\n" +
    "    res <- tryCatch({ install.packages(p, repos = " +
    `"${R_CRAN_REPO}"); "ok" }, error = function(e) "fail", warning = function(w) "fail");\n` +
    "    if (identical(res, 'ok') && requireNamespace(p, quietly = TRUE)) {\n" +
    "      ok <- c(ok, sanitize(p));\n" +
    "    } else { failed <- c(failed, sanitize(p)) }\n" +
    "  };\n" +
    "  if (length(ok)) cat('\n" + INSTALL_OK_MARKER + " ', paste(ok, collapse = ' '), '\\n', sep = '');\n" +
    "  if (length(failed)) cat('\n" + INSTALL_FAILED_MARKER + " ', paste(failed, collapse = ' '), '\\n', sep = '');\n" +
    "})"
  );
}

/** CRAN mirror used for R hot-installs (kept in sync with buildInstallCode). */
export const R_CRAN_REPO = "https://cloud.r-project.org";

/**
 * Parsed outcome of an install run, derived from its collected stdout.
 * `hasMarkers` tells the caller whether the per-package markers were seen —
 * without them we can only fall back to whole-batch success/failure.
 */
export type InstallOutputReport = {
  hasMarkers: boolean;
  /** Base names that ARE loadable after the run. */
  ok: string[];
  /** Base names that failed to install / are not loadable. */
  failed: string[];
};

/**
 * Parse the PI_INSTALL_* markers out of an install run's collected stdout.
 * Tolerant of surrounding install noise and of either marker being absent
 * (a fully-successful run prints no FAILED line, and vice versa).
 */
export function parseInstallOutput(stdoutText: string): InstallOutputReport {
  const read = (marker: string): string[] => {
    const line = stdoutText
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.startsWith(marker));
    if (!line) return [];
    return line
      .slice(marker.length)
      .trim()
      .split(/\s+/)
      .filter(Boolean);
  };
  const ok = read(INSTALL_OK_MARKER);
  const failed = read(INSTALL_FAILED_MARKER);
  return { hasMarkers: ok.length > 0 || failed.length > 0, ok, failed };
}

/**
 * Build a lightweight, kernel-side reachability probe for the install source.
 * Pure and deterministic. Returns "" when the language needs no probe.
 *
 * R has no install timeout of its own: when the remote host cannot reach CRAN
 * (a common setup behind a firewall), `install.packages` blocks on the network
 * until our `installTimeoutMs` (minutes) and then surfaces as an opaque error.
 * Probing the repo first fails fast with a clear, actionable message (BUG-8).
 *
 *   r → opens a connection to the repo root; prints TRUE/FALSE. warn=2 promotes
 *       the connection failure to an error, which we treat as "unreachable".
 *   python → "" (%pip fails fast with its own readable network error).
 */
export function installProbeCode(language = "python"): string {
  const lang = language.toLowerCase();
  if (lang === "r") {
    return (
      "local({ old <- options(warn = 2); on.exit(options(old)); " +
      `cat(isTRUE(tryCatch({ con <- url(${rString(R_CRAN_REPO)}, open = \"r\"); ` +
      "close(con); TRUE }, error = function(e) FALSE, warning = function(w) FALSE))) })"
    );
  }
  return "";
}

/**
 * Decide whether the probe's collected stdout reports the repo as reachable.
 * Tolerates noise: only the last non-empty line matters (a stray FALSE earlier
 * in the stream must not mask a later TRUE).
 */
export function isRepoReachable(stdoutText: string): boolean {
  const lines = stdoutText.trim().split(/\r?\n/).filter((l) => l.trim() !== "");
  const last = (lines[lines.length - 1] ?? "").trim();
  return /^TRUE$/i.test(last);
}

/** Escape a package spec into a double-quoted R string literal. */
function rString(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
