/**
 * Unit tests: dependency manager (language-aware install code builder).
 */
import { describe, expect, it } from "vitest";
import { buildInstallCode, parseInstallOutput } from "../../src/domain/deps";

describe("buildInstallCode (python)", () => {
  it("emits one %pip line per package", () => {
    expect(buildInstallCode(["pandas", "numpy"])).toBe(
      "%pip install --quiet pandas\n%pip install --quiet numpy",
    );
  });

  it("defaults to python when no language is given", () => {
    expect(buildInstallCode(["requests"])).toBe("%pip install --quiet requests");
  });

  it("dedupes and trims", () => {
    expect(buildInstallCode([" pandas ", "pandas", "numpy"])).toBe(
      "%pip install --quiet pandas\n%pip install --quiet numpy",
    );
  });

  it("drops empty / whitespace-only entries", () => {
    expect(buildInstallCode(["", "  ", "requests"])).toBe("%pip install --quiet requests");
  });

  it("returns empty string for no packages", () => {
    expect(buildInstallCode([])).toBe("");
    expect(buildInstallCode(["", "  "])).toBe("");
  });

  it("preserves version specifiers", () => {
    expect(buildInstallCode(["pandas>=2"])).toBe("%pip install --quiet pandas>=2");
  });
});

describe("buildInstallCode (r)", () => {
  it("emits install.packages with a CRAN repo, never %pip", () => {
    const code = buildInstallCode(["ggplot2"], "r");
    expect(code).toContain("install.packages");
    expect(code).toContain("https://cloud.r-project.org");
    expect(code).toContain('"ggplot2"');
    expect(code).not.toContain("%pip");
  });

  it("installs each R package individually (one unavailable name can't abort the batch)", () => {
    const code = buildInstallCode(["dplyr", "tidyr"], "R");
    // Per-package isolation (issue "poisoned deps set", Option 3): no single
    // install.packages(c(...)) batch that getDependencies() can abort wholesale.
    // Instead the names go into an iteration list and each is installed in its
    // own tryCatch, verified by requireNamespace, so one bad name can't stop
    // the rest.
    expect(code).not.toContain("install.packages(c(");
    expect(code).toContain('pkgs <- c("dplyr", "tidyr")');
    expect(code).toContain("for (p in pkgs)");
    expect(code).toContain("install.packages(p");
    expect(code).toContain("tryCatch");
    expect(code).toContain("requireNamespace");
  });

  it("escapes quotes and backslashes in package specs", () => {
    const code = buildInstallCode(['evil"name'], "r");
    expect(code).toContain('"evil\\"name"');
  });

  it("dedupes R packages too", () => {
    const code = buildInstallCode(["ggplot2", " ggplot2 "], "r");
    // The deduped name appears exactly once — in the iteration list. The loop
    // body installs via the `p` variable, so a duplicate would show up here.
    expect(code.match(/"ggplot2"/g)).toHaveLength(1);
  });
});

describe("buildInstallCode (other languages)", () => {
  it("throws an explicit error for unsupported languages", () => {
    expect(() => buildInstallCode(["foo"], "julia")).toThrow(/unsupported language/);
  });

  it("returns empty string before checking language when no packages", () => {
    expect(buildInstallCode([], "julia")).toBe("");
  });
});

describe("parseInstallOutput (per-package markers)", () => {
  it("parses a fully-successful run", () => {
    const r = parseInstallOutput("noise\nPI_INSTALL_OK ggplot2 dplyr\n");
    expect(r.hasMarkers).toBe(true);
    expect(r.ok).toEqual(["ggplot2", "dplyr"]);
    expect(r.failed).toEqual([]);
  });

  it("parses a partial-failure run", () => {
    const r = parseInstallOutput(
      "PI_INSTALL_OK ggplot2\nPI_INSTALL_FAILED nonexistent-pkg-zzz-test\n",
    );
    expect(r.ok).toEqual(["ggplot2"]);
    expect(r.failed).toEqual(["nonexistent-pkg-zzz-test"]);
  });

  it("parses an all-failed run (no OK marker)", () => {
    const r = parseInstallOutput("PI_INSTALL_FAILED badpkg\n");
    expect(r.hasMarkers).toBe(true);
    expect(r.ok).toEqual([]);
    expect(r.failed).toEqual(["badpkg"]);
  });

  it("reports no markers for plain output", () => {
    const r = parseInstallOutput("installing ... done\n");
    expect(r.hasMarkers).toBe(false);
    expect(r.ok).toEqual([]);
    expect(r.failed).toEqual([]);
  });
});
