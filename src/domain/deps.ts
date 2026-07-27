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

/** Escape a package spec into a double-quoted R string literal. */
function rString(p: string): string {
  return `"${p.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
