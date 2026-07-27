/**
 * Unit tests: dependency manager (language-aware install code builder).
 */
import { describe, expect, it } from "vitest";
import { buildInstallCode } from "../../src/domain/deps";

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

  it("maps multiple packages to an R string vector", () => {
    const code = buildInstallCode(["dplyr", "tidyr"], "R");
    expect(code).toContain('c("dplyr", "tidyr")');
  });

  it("escapes quotes and backslashes in package specs", () => {
    const code = buildInstallCode(['evil"name'], "r");
    expect(code).toContain('"evil\\"name"');
  });

  it("dedupes R packages too", () => {
    const code = buildInstallCode(["ggplot2", " ggplot2 "], "r");
    expect(code.match(/ggplot2/g)).toHaveLength(1);
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
