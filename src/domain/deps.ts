/**
 * DependencyManager — hot-install packages into the running kernel.
 *
 * The install command is *language-aware* because `%pip` is an IPython-only
 * magic:
 *
 *   python → `%pip install --quiet <p>`   (IPython built-in; installs into the
 *                                           current kernel's env, never system)
 *   r      → `install.packages(c(...), repos = "https://cloud.r-project.org")`
 *            (wrapped so warnings become errors — a failed CRAN install then
 *             surfaces as an error output instead of a silent no-op)
 *   other  → unsupported; we refuse rather than emit code that cannot work.
 *
 * The install log streams back as normal stdout; failures surface as error
 * outputs, which the session checks (see `session.ts` install()).
 */

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
    const vector = uniq.map((p) => rString(p)).join(", ");
    // warn = 2 promotes install-failure warnings to errors so a failed CRAN
    // install is caught by the session's error check; on.exit restores options.
    return (
      "local({ old <- options(warn = 2); on.exit(options(old)); " +
      `install.packages(c(${vector}), repos = "https://cloud.r-project.org") })`
    );
  }
  throw new Error(`[pi-jupyter] unsupported language for hot-install: ${language}`);
}

/** CRAN mirror used for R hot-installs (kept in sync with buildInstallCode). */
export const R_CRAN_REPO = "https://cloud.r-project.org";

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
