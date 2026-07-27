/**
 * DependencyManager — hot-install packages into the running kernel via %pip.
 *
 * `%pip` is an IPython built-in magic guaranteed to install into the *current
 * kernel's* environment, never the system Python — so we never need to know
 * the remote machine's Python version or path (C3).  The install log streams
 * back as normal stdout; failures surface as error outputs.
 */

/** Build the install code for a set of package specs. Pure and deterministic. */
export function buildInstallCode(packages: string[]): string {
  const uniq = [...new Set(packages.map((p) => p.trim()).filter(Boolean))];
  if (uniq.length === 0) return "";
  return uniq.map((p) => `%pip install --quiet ${p}`).join("\n");
}
