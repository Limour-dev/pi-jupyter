/**
 * Unit tests: dependency manager (%pip code builder).
 */
import { describe, expect, it } from "vitest";
import { buildInstallCode } from "../../src/domain/deps";

describe("buildInstallCode", () => {
  it("emits one %pip line per package", () => {
    expect(buildInstallCode(["pandas", "numpy"])).toBe(
      "%pip install --quiet pandas\n%pip install --quiet numpy",
    );
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
